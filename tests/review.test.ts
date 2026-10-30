import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { GuestClient } from "../src/classify/client.js";
import { review } from "../src/review/review.js";
import { buildSymbolGraph } from "../src/gate/symbolGraph.js";

const exec = promisify(execFile);
const root = process.cwd();

async function sh(cwd: string, cmd: string, args: string[]) {
  await exec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Scripted model (no live model, no sealed reads): one stub serves
 * Spark (report_findings) and Wonder. Wonder returns the edit plan
 * AND the review note in one response — `wonderCalls` proves review()
 * still makes exactly one Wonder call.
 */
function scripted(sparkFindings: unknown, wonderEdits: unknown, wonderReview: unknown = []) {
  const state = { wonderCalls: 0 };
  const client = {
    config: { baseUrl: "stub", apiKey: "stub", model: "scripted" },
    async chat(req: { tools?: { function: { name: string } }[] }) {
      const tool = req.tools?.[0]?.function.name ?? "";
      if (tool !== "report_findings") state.wonderCalls++;
      const payload =
        tool === "report_findings"
          ? { findings: sparkFindings }
          : tool === "repair_patch"
            ? { newFiles: [] }
            : { edits: wonderEdits, review: wonderReview };
      return {
        content: null,
        toolCalls: [{ id: "c1", type: "function" as const, function: { name: tool, arguments: JSON.stringify(payload) } }],
        finishReason: "tool_calls",
      };
    },
  } as unknown as GuestClient;
  return { client, state };
}

async function materialize(n: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), `lc-review-${n}-`));
  const dir = join(tmp, "f");
  await sh(root, "bash", ["fixtures/scripts/materialize.sh", n, dir]);
  await sh(dir, "npm", ["install", "--no-audit", "--no-fund", "--silent"]);
  await sh(dir, "git", ["checkout", "-q", "bloated-pr"]);
  return dir;
}

const cite = (file: string, startLine: number, endLine: number) => ({ file, startLine, endLine });

describe("review", () => {
  it("symbol graph resolves an import to a .js file", () => {
    const graph = buildSymbolGraph(new Map([
      ["src/helper.js", "export function helper() { return 1; }"],
      ["src/use.js", 'import { helper } from "./helper.js";\nexport const out = helper();'],
    ]));
    expect(graph.get("src/helper.js")!.referencedByOthers.has("helper")).toBe(true);
  });

  it("fixture 6: a JavaScript single-use wrapper is inlined under allowJs", async () => {
    const dir = await materialize("6");
    const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout;
    const spark = [
      { category: "single-use-abstraction", file: "src/userApi.js", citations: [cite("src/userApi.js", 1, 5)], rationale: "single-use JS wrapper" },
    ];
    const wonder = [
      {
        findingIndex: 0, action: "inline",
        newFiles: [{ file: "src/userLabel.js", content: 'import { getJson } from "./client.js";\nexport function fetchUserLabel(id) {\n  return getJson(`/users/${id}`).then((user) => `${user.name} <${user.email}>`);\n}\n' }],
        deleteFiles: ["src/userApi.js"], rationale: "inline the JS wrapper",
      },
    ];
    const { client, state } = scripted(spark, wonder);
    const r = await review({ checkout: dir, base: "base", intent: ["src/userLabel.js", "src/userApi.js"], sparkClient: client, wonderClient: client });
    expect(r.verdict, JSON.stringify(r, null, 2)).toBe("accepted");
    expect(r.applied).toContain("getJson(`/users/${id}`)");
    expect(r.applied).not.toContain("+  return fetchUser(id)"); // wrapper call survives only as a removed line
    expect(r.gate?.accepted).toBe(true);
    // checkJs stays as the repository set it (off) — the untyped .js
    // file is not failed for missing types; tsc passed above.
    expect(r.detail.tsConfig).toEqual({ allowJs: true, checkJs: false });
    expect(state.wonderCalls).toBe(1);
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout).toBe(headBefore);
    expect(readFileSync(join(dir, "src/userLabel.js"), "utf8")).toContain("fetchUser(id)"); // caller untouched
  }, 300_000);

  it("fixture 7: a non-mechanical design problem is in the note and absent from the patch", async () => {
    const dir = await materialize("7");
    const { client } = scripted([], [], [
      {
        kind: "boundary",
        text: "renderReceipt re-derives the invoice presentation instead of sharing the Invoice concept; formatting changes must be made in two places.",
        citations: [cite("src/report.ts", 5, 10)],
      },
      {
        kind: "question",
        text: "This citation was invented, so code must drop the item.",
        citations: [cite("src/report.ts", 90, 99)],
      },
    ]);
    const r = await review({ checkout: dir, base: "base", intent: ["src/report.ts"], sparkClient: client, wonderClient: client });
    // Note-only run is a success: verdict reviewed, nothing applied.
    expect(r.verdict).toBe("reviewed");
    expect(r.applied).toBe("");
    expect(r.review.items).toHaveLength(1);
    expect(r.review.items[0]!.kind).toBe("boundary");
    expect(r.review.markdown).toContain("renderReceipt re-derives");
    expect(r.review.markdown).toContain("src/report.ts:5-10");
    expect(r.applied).not.toContain("renderReceipt");
  }, 300_000);

  it("replaces a note item that orders an edit the gate rejected", async () => {
    const dir = await materialize("5");
    // PR head = base pricing (helpers present), as in simplify fixture 5.
    const basePricing = readFileSync(join(root, "fixtures/5/base/src/pricing.ts"), "utf8");
    writeFileSync(join(dir, "src/pricing.ts"), basePricing);
    await sh(dir, "git", ["add", "src/pricing.ts"]);
    await sh(dir, "git", ["-c", "user.email=t@l", "-c", "user.name=t", "commit", "-qm", "pr head with helpers"]);
    const god = [
      "export interface OrderLine { price: number; quantity: number; category: string; member: boolean; gift: boolean; coupon: boolean; }",
      "export function totalPrice(lines: OrderLine[]): number {",
      "  let total = 0;",
      "  for (const line of lines) {",
      "    let rate = 0;",
      '    if (line.category === "clearance") rate = 0.4;',
      "    else if (line.member && line.price > 100) rate = 0.2;",
      "    else if (line.member) rate = 0.1;",
      "    else if (line.price > 200) rate = 0.05;",
      "    if (line.gift) rate = 0;",
      '    else if (line.coupon && line.category === "books") rate = Math.max(rate, 0.15);',
      '    else if (line.coupon || line.category === "seasonal") rate = Math.max(rate, 0.08);',
      "    total += line.price * line.quantity * (1 - rate);",
      "  }",
      "  return total;",
      "}",
      "",
    ].join("\n");
    const spark = [
      { category: "single-use-abstraction", file: "src/pricing.ts", citations: [cite("src/pricing.ts", 10, 23)], rationale: "helpers look single-use" },
    ];
    const wonder = [
      { findingIndex: 0, action: "inline", newFiles: [{ file: "src/pricing.ts", content: god }], deleteFiles: [], rationale: "inline all helpers" },
    ];
    const note = [
      { kind: "boundary", text: "Inline every pricing helper into totalPrice.", citations: [cite("src/pricing.ts", 10, 23)], ordersEditForFinding: 0 },
    ];
    const { client } = scripted(spark, wonder, note);
    const r = await review({ checkout: dir, base: "base", intent: ["src/pricing.ts"], sparkClient: client, wonderClient: client });
    expect(r.applied).toBe("");
    expect(r.verdict).toBe("reviewed");
    expect(r.review.items).toHaveLength(1);
    expect(r.review.items[0]!.text).toMatch(/^Not applied: the gate rejected/);
    expect(r.review.items[0]!.text).toMatch(/cyclomatic/);
  }, 300_000);

  it("fixture 8: a registry practice is applied; the same practice without a registry is note-only", async () => {
    const spark = [
      { category: "convention-break", file: "src/greet.ts", convention: "no-console-log", citations: [cite("src/greet.ts", 2, 2)], rationale: "console.log in source" },
    ];
    const wonder = [
      { findingIndex: 0, action: "convention-fix", newFiles: [], deleteFiles: [], rationale: "code applies the mechanical fix" },
    ];

    const registered = await materialize("8");
    const a = scripted(spark, wonder);
    const appliedRun = await review({ checkout: registered, base: "base", intent: ["src/greet.ts"], sparkClient: a.client, wonderClient: a.client });
    expect(appliedRun.verdict, JSON.stringify(appliedRun, null, 2)).toBe("accepted");
    expect(appliedRun.applied).toContain("-  console.log(name);");
    expect(appliedRun.detail.registry).toEqual(["no-console-log"]);

    // Same checkout, same practice, registry removed → note only.
    const unregistered = await materialize("8");
    await sh(unregistered, "rm", ["lesscode-conventions.json"]);
    await sh(unregistered, "git", ["add", "-A"]);
    await sh(unregistered, "git", ["-c", "user.email=t@l", "-c", "user.name=t", "commit", "-qm", "drop registry"]);
    const b = scripted(spark, wonder);
    const noteRun = await review({ checkout: unregistered, base: "base", intent: ["src/greet.ts"], sparkClient: b.client, wonderClient: b.client });
    expect(noteRun.verdict).toBe("reviewed");
    expect(noteRun.applied).toBe("");
    expect(noteRun.applied).not.toContain("console.log");
    expect(noteRun.review.items.some((i) => i.kind === "practice" && i.text.includes("no-console-log"))).toBe(true);
  }, 300_000);

  it("LES-19: drops note items citing files outside the change, keeps one Wonder call", async () => {
    const dir = await materialize("7");
    const { client, state } = scripted([], [], [
      { kind: "boundary", text: "Outside the change: talks about an untouched file.", citations: [cite("vitest.config.ts", 1, 1)] },
      { kind: "boundary", text: "About the changed report file.", citations: [cite("src/report.ts", 5, 10)] },
    ]);
    const r = await review({ checkout: dir, base: "base", intent: ["src/report.ts"], sparkClient: client, wonderClient: client });
    expect(r.verdict).toBe("reviewed");
    expect(r.review.items.map((i) => i.text)).toEqual(["About the changed report file."]);
    expect(state.wonderCalls).toBe(1);
  }, 300_000);

  it("failed only when the run itself cannot finish", async () => {
    const r = await review({ checkout: root, base: "base", intent: [] });
    expect(r.verdict).toBe("failed");
    expect(r.applied).toBe("");
    expect(r.detail.error).toMatch(/intent is required/);
  });
});
