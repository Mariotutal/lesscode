import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { GuestClient } from "../src/classify/client.js";
import type { Finding } from "../src/classify/schema.js";
import { planOnce, WONDER_MODEL } from "../src/plan/plan.js";
import { applyPlan } from "../src/plan/apply.js";
import { planOutputSchema } from "../src/plan/schema.js";

const exec = promisify(execFile);

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "lc-plan-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(d, name, ".."), { recursive: true });
    writeFileSync(join(d, name), text);
  }
  return d;
}

function stub(outputs: unknown[], model = WONDER_MODEL): GuestClient & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() { return state.calls; },
    config: { baseUrl: "stub", apiKey: "stub", model },
    async chat(req) {
      const raw = outputs[Math.min(state.calls++, outputs.length - 1)];
      const tool = req.tools?.[0]?.function.name ?? "propose_surgical_patch";
      return {
        content: null,
        toolCalls: [{ id: "c1", type: "function" as const, function: { name: tool, arguments: JSON.stringify(raw) } }],
        finishReason: "tool_calls",
      };
    },
  } as GuestClient & { calls: number };
}

const WRAP: Finding = {
  category: "single-use-abstraction",
  file: "src/wrap.ts",
  citations: [{ file: "src/wrap.ts", startLine: 1, endLine: 4 }, { file: "src/use.ts", startLine: 2, endLine: 2 }],
  rationale: "single-use forward",
};
const FILES = {
  "src/wrap.ts": "export class Wrapper {\n  constructor(private readonly inner: { get(): number }) {}\n  fetch(): number { return this.inner.get(); }\n}\n",
  "src/use.ts": 'import { Wrapper } from "./wrap.js";\nexport const out = new Wrapper({ get: () => 1 }).fetch();\n',
};
const INLINED_USE = "export const out = { get: () => 1 }.get();\n";

describe("plan schema", () => {
  it("rejects unknown actions", () => {
    expect(planOutputSchema.safeParse({ edits: [{ findingIndex: 0, action: "rewrite-feature", rationale: "x" }] }).success).toBe(false);
  });
});

describe("planOnce", () => {
  it("makes exactly one Wonder call and keeps a cited inline", async () => {
    const client = stub([{ edits: [{ findingIndex: 0, action: "inline", newFiles: [{ file: "src/use.ts", content: INLINED_USE }], deleteFiles: ["src/wrap.ts"], rationale: "inline forward" }] }]);
    const r = await planOnce({ checkoutDir: dir(FILES), findings: [WRAP], client });
    expect(client.calls).toBe(1);
    expect(r.modelCalls).toBe(1);
    expect(r.edits).toHaveLength(1);
  });

  it("invalid plan -> no edits, still exactly one call (no retry)", async () => {
    const client = stub([{ edits: [{ findingIndex: 0, action: "nope", rationale: "x" }] }]);
    const r = await planOnce({ checkoutDir: dir(FILES), findings: [WRAP], client });
    expect(client.calls).toBe(1);
    expect(r.edits).toEqual([]);
    expect(r.skipped[0]!.reason).toMatch(/schema/);
  });

  it("refuses edits touching tests, sealed, or uncited files; action must match category", async () => {
    const client = stub([{ edits: [
      { findingIndex: 0, action: "inline", newFiles: [{ file: "tests/x.test.ts", content: "" }], deleteFiles: [], rationale: "x" },
    ] }]);
    const r = await planOnce({ checkoutDir: dir(FILES), findings: [WRAP], client });
    expect(r.edits).toEqual([]);
    expect(r.skipped[0]!.reason).toMatch(/tests or sealed/);

    const client2 = stub([{ edits: [{ findingIndex: 0, action: "retarget", newFiles: [], deleteFiles: ["src/wrap.ts"], rationale: "x" }] }]);
    const r2 = await planOnce({ checkoutDir: dir(FILES), findings: [WRAP], client: client2 });
    expect(r2.edits).toEqual([]);
    expect(r2.skipped[0]!.reason).toMatch(/does not match category/);
  });
});

describe("applyPlan", () => {
  it("applies an inline, deleting the wrapper", async () => {
    const d = dir(FILES);
    const r = await applyPlan({
      checkoutDir: d, baseRef: "base", findings: [WRAP],
      edits: [{ findingIndex: 0, action: "inline", newFiles: [{ file: "src/use.ts", content: INLINED_USE }], deleteFiles: ["src/wrap.ts"], rationale: "x" }],
      runTsc: async () => null,
    });
    expect(r.applied).toHaveLength(1);
    expect(existsSync(join(d, "src/wrap.ts"))).toBe(false);
    expect(readFileSync(join(d, "src/use.ts"), "utf8")).toBe(INLINED_USE);
    expect(r.editSet).toEqual(["src/use.ts", "src/wrap.ts"]);
  });

  it("no repair turn on tsc failure: skips and reverts that finding (LES-21)", async () => {
    const d = dir(FILES);
    const client = stub([{ newFiles: [{ file: "src/use.ts", content: "still broken" }] }]);
    const r = await applyPlan({
      checkoutDir: d, baseRef: "base", findings: [WRAP],
      edits: [{ findingIndex: 0, action: "inline", newFiles: [], deleteFiles: [], rationale: "x" }],
      client,
      runTsc: async () => "error TS2304: nope",
    });
    expect(client.calls).toBe(0); // no repair turn is ever taken
    expect(r.repairCalls).toBe(0);
    expect(r.applied).toEqual([]);
    expect(r.skipped[0]!.reason).toMatch(/no repair turn/);
    expect(readFileSync(join(d, "src/use.ts"), "utf8")).toBe(FILES["src/use.ts"]); // reverted
    expect(existsSync(join(d, "src/wrap.ts"))).toBe(true);
  });

  it("refuses model-supplied contents that alter an unrelated statement", async () => {
    const d = dir(FILES);
    const tampered = "export const out = { get: () => 1 }.get();\nexport const unrelated = 99;\n";
    const r = await applyPlan({
      checkoutDir: d, baseRef: "base", findings: [WRAP],
      edits: [{ findingIndex: 0, action: "inline", newFiles: [{ file: "src/use.ts", content: tampered }], deleteFiles: [], rationale: "x" }],
      runTsc: async () => null,
    });
    expect(r.applied).toEqual([]);
    expect(r.skipped[0]!.reason).toMatch(/unrelated-change guard/);
    expect(readFileSync(join(d, "src/use.ts"), "utf8")).toBe(FILES["src/use.ts"]);
    expect(existsSync(join(d, "src/wrap.ts"))).toBe(true);
  });

  it("restore-from-base comes from git, not the model", async () => {
    const d = dir({ ...FILES, "src/extra.ts": "export const creep = 1;\n" });
    await exec("git", ["init", "-q", "-b", "base"], { cwd: d });
    await exec("git", ["add", "-A"], { cwd: d });
    // base has no extra.ts; commit everything else, then re-add creep in worktree
    await exec("git", ["rm", "-q", "--cached", "src/extra.ts"], { cwd: d });
    await exec("git", ["-c", "user.email=t@l", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: d });
    const creep = { category: "scope-creep" as const, file: "src/extra.ts", citations: [{ file: "src/extra.ts", startLine: 1, endLine: 1 }], action: "restore-from-base" as const, rationale: "creep" };
    const r = await applyPlan({
      checkoutDir: d, baseRef: "base", findings: [creep],
      edits: [{ findingIndex: 0, action: "restore-from-base", newFiles: [], deleteFiles: [], rationale: "x" }],
      runTsc: async () => null,
    });
    expect(r.applied).toHaveLength(1);
    expect(existsSync(join(d, "src/extra.ts"))).toBe(false);
  });
});
