import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runReview } from "../src/engine/run.js";
import { transactEdit } from "../src/engine/transaction.js";
import { measureSource } from "../src/gate/metrics.js";
import type { GuestClient } from "../src/classify/client.js";

const temporary: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "lc-engine-test-")); temporary.push(dir); return dir; }
function put(dir: string, path: string, text: string) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); }
function repository(files: Record<string, string>) {
  const dir = directory();
  for (const [path, text] of Object.entries(files)) put(dir, path, text);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Tests", "-c", "user.email=tests@localhost", "commit", "-qm", "head"], { cwd: dir });
  return dir;
}
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const cite = (file: string, startLine: number, endLine: number) => ({ file, startLine, endLine });
const finding = { category: "single-use-abstraction", file: "src/wrap.js", citations: [cite("src/wrap.js", 2, 4)], rationale: "single use" };
const inline = { findingIndex: 0, action: "inline", newFiles: [], deleteFiles: [], rationale: "inline" };
const files = {
  "package.json": JSON.stringify({ type: "module", scripts: { test: "node tests/app.test.js" } }),
  "src/inner.js": "export function inner(x) { return x; }\n",
  "src/wrap.js": 'import {inner} from "./inner.js";\nexport function wrap(x) {\n return inner(x);\n}\n',
  "src/use.js": 'import {wrap} from "./wrap.js";\nexport const run = () => wrap(1);\n',
  "tests/app.test.js": 'import {run} from "../src/use.js";\nif(run()!==1) throw new Error("bad");\n',
};
function model(findings: unknown[] = [finding], edits: unknown[] = [inline], note: unknown[] = []): GuestClient {
  return { config: { model: "scripted", baseUrl: "stub", apiKey: "test" }, async chat(req) {
    const name = req.tools![0]!.function.name;
    return { content: null, finishReason: "tool_calls", toolCalls: [{ id: "1", type: "function", function: { name, arguments: JSON.stringify(name === "report_findings" ? { findings } : { edits, review: note }) } }] };
  } };
}

 describe("atomic edit transactions", () => {
  it("restores every importer and deletion after rejection or a verification exception", async () => {
    const dir = directory(); put(dir, "src/a.js", "before-a"); put(dir, "src/b.js", "before-b");
    const edit = { findingIndex: 0, changes: [{ path: "src/a.js", before: "before-a", after: null }, { path: "src/b.js", before: "before-b", after: "after-b" }, { path: "src/c.js", before: null, after: "new" }] };
    await transactEdit(dir, edit, async () => ({ keep: false, result: "rejected" }));
    await expect(transactEdit(dir, edit, async () => { throw new Error("verification crashed"); })).rejects.toThrow("verification crashed");
    expect(readFileSync(join(dir, "src/a.js"), "utf8")).toBe("before-a");
    expect(readFileSync(join(dir, "src/b.js"), "utf8")).toBe("before-b");
    expect(existsSync(join(dir, "src/c.js"))).toBe(false);
  });
  it("rejects stale preimages, test edits, and symlink escapes before writing", async () => {
    const dir = directory(); put(dir, "src/a.js", "real");
    const check = async () => ({ keep: true, result: null });
    await expect(transactEdit(dir, { findingIndex: 0, changes: [{ path: "src/a.js", before: "old", after: "new" }] }, check)).rejects.toThrow(/stale/);
    await expect(transactEdit(dir, { findingIndex: 0, changes: [{ path: "tests/a.test.js", before: null, after: "new" }] }, check)).rejects.toThrow(/may not write/);
    symlinkSync(directory(), join(dir, "linked"));
    await expect(transactEdit(dir, { findingIndex: 0, changes: [{ path: "linked/a.js", before: null, after: "new" }] }, check)).rejects.toThrow();
    expect(readFileSync(join(dir, "src/a.js"), "utf8")).toBe("real");
  });
});

describe("one review engine", () => {
  it("binds an accepted artifact to its revision and excludes all writes of an unsafe edit", async () => {
    const dir = repository({ ...files,
      "src/existing.js": "export function fmt(x) { return x; }\n",
      "src/dup.js": "export function fmt(x) { return x; }\nexport const sentinel = 42;\n",
      "src/consumer.js": 'import {fmt} from "./dup.js";\nexport const value = fmt(1);\n',
      "tests/app.test.js": files["tests/app.test.js"] + 'import {value} from "../src/consumer.js";\nif(value!==1) throw new Error("bad");\n',
    });
    const duplicate = { category: "duplicate-helper", file: "src/dup.js", existingHelperFile: "src/existing.js", citations: [cite("src/dup.js", 1, 1)], rationale: "duplicate" };
    const client = model([finding, duplicate], [inline, { ...inline, findingIndex: 1, action: "retarget" }]);
    const r = await runReview({ checkout: dir, base: "HEAD", intent: Object.keys(files), sparkClient: client, wonderClient: client });
    expect(r.verdict, JSON.stringify(r.failure ?? r.audit.reasons)).toBe("accepted");
    expect(r.edits.find((e) => e.findingIndex === 1)?.status).toBe("skipped");
    expect(r.artifact!.patch).not.toContain("src/consumer.js");
    expect(r.artifact!.headSha).toBe(r.revision!.headSha);
    expect(r.artifact!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(r.verification.treeHash).toBe(r.artifact!.treeHash);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");
  }, 30_000);

  it("withdraws edits and rewrites the note when final command verification fails", async () => {
    const dir = repository({ ...files, "package.json": JSON.stringify({ type: "module", scripts: { test: "node -e 'process.exit(1)'" } }) });
    const client = model([finding], [inline], [{ kind: "load-bearing", text: "Inline this wrapper.", citations: [cite("src/wrap.js", 2, 4)], ordersEditForFinding: 0 }]);
    const r = await runReview({ checkout: dir, base: "HEAD", intent: Object.keys(files), sparkClient: client, wonderClient: client });
    expect(r.verdict).toBe("reviewed"); expect(r.outcome).toBe("unverified"); expect(r.artifact).toBeNull();
    expect(r.edits[0]?.status).toBe("withdrawn");
    expect(r.review.markdown).toContain("Not applied:"); expect(r.review.markdown).toContain("related-tests-pass");
  }, 30_000);

  it("refuses source mutations made by repository verification commands", async () => {
    const script = `require('node:fs').writeFileSync('src/use.js','export const run=()=>999;\\n')`;
    const dir = repository({ ...files, "package.json": JSON.stringify({ type: "module", scripts: { test: `node -e ${JSON.stringify(script)}` } }) });
    const client = model();
    const r = await runReview({ checkout: dir, base: "HEAD", intent: Object.keys(files), sparkClient: client, wonderClient: client });
    expect(r.artifact).toBeNull();
    expect(r.gate?.checks.find((c) => c.name === "verified-tree-unchanged")?.passed).toBe(false);
    expect(readFileSync(join(dir, "src/use.js"), "utf8")).toBe(files["src/use.js"]);
  }, 30_000);

  it("uses the analyzed snapshot for citations even when the caller edits its checkout during a run", async () => {
    const dir = repository(files);
    const baseClient = model([finding], [inline], [{ kind: "load-bearing", text: "The change is sound.", citations: [cite("src/wrap.js", 2, 4)] }]);
    const client: GuestClient = { ...baseClient, async chat(req) { put(dir, "src/wrap.js", "// caller edited this\n"); return baseClient.chat(req); } };
    const r = await runReview({ checkout: dir, base: "HEAD", intent: Object.keys(files), sparkClient: client, wonderClient: client });
    expect(r.verdict).toBe("accepted"); expect(r.review.items).toHaveLength(1);
    expect(readFileSync(join(dir, "src/wrap.js"), "utf8")).toBe("// caller edited this\n");
  }, 30_000);

  it("returns failure evidence and a manifest, and skips models for empty inferred scope", async () => {
    const dir = repository(files);
    let calls = 0;
    const client: GuestClient = { config: { model: "failed-model", apiKey: "secret", baseUrl: "stub" }, async chat() { calls++; throw new Error("transport failed"); } };
    const failed = await runReview({ checkout: dir, base: "HEAD", intent: ["src/wrap.js"], sparkClient: client });
    expect(failed.state).toBe("failed"); expect(failed.failure?.stage).toBe("classify");
    expect(failed.manifest.callsByModel.spark).toBe(1); expect(failed.manifest.promptHashes).toHaveLength(1);
    expect(JSON.stringify(failed.manifest)).not.toContain("secret");
    const skipped = await runReview({ checkout: dir, base: "HEAD", intent: [], scope: { kind: "inferred", paths: [] }, sparkClient: client });
    expect(skipped.verdict).toBe("reviewed"); expect(skipped.manifest.modelCalls).toBe(0); expect(calls).toBe(1);
    const mismatch = await runReview({ checkout: dir, base: "HEAD", expectedHeadSha: "0".repeat(40), intent: ["src/wrap.js"], sparkClient: client });
    expect(mismatch.failure?.message).toMatch(/does not match/); expect(calls).toBe(1);
  });
});

it("keeps a surviving method's metric identity when a preceding class with the same method is removed", () => {
  const before = measureSource("a.ts", "class A { run(){ return 1; } }\nclass B { run(){ if(true)return 1;return 0; } }");
  const after = measureSource("a.ts", "class B { run(){ if(true)return 1;return 0; } }");
  expect(after.functions[0]!.key).toBe(before.functions[1]!.key);
});
