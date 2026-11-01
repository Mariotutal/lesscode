import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { GuestClient } from "../src/classify/client.js";
import { review } from "../src/review/review.js";
import { PR_DECLARATION_FILE, gateCheck, noteComment, postFor, readPrDeclaration, runPrReview } from "../src/pr/index.js";

const exec = promisify(execFile);
const root = process.cwd();

async function sh(cwd: string, cmd: string, args: string[]) {
  await exec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Scripted model (same stub shape as tests/review.test.ts): one stub
 * serves Spark (report_findings) and Wonder, which returns the edit
 * plan AND the review note in one response. `wonderCalls` proves the
 * PR caller still goes through review()'s single Wonder call. No live
 * model, no sealed reads.
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

/**
 * Materialize a fixture as a local pull-request fixture: the fixture
 * repo (branches base, bloated-pr) with the PR's declared
 * lesscode-pr.json written into the PR checkout. The declaration is
 * uncommitted on purpose: the caller must not modify the branch, and
 * the tests assert it does not.
 */
async function materializePr(n: string, declaration: unknown): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), `lc-pr-${n}-`));
  const dir = join(tmp, "f");
  await sh(root, "bash", ["fixtures/scripts/materialize.sh", n, dir]);
  await sh(dir, "npm", ["install", "--no-audit", "--no-fund", "--silent"]);
  await sh(dir, "git", ["checkout", "-q", "bloated-pr"]);
  if (declaration !== undefined) writeFileSync(join(dir, PR_DECLARATION_FILE), JSON.stringify(declaration));
  return dir;
}

const cite = (file: string, startLine: number, endLine: number) => ({ file, startLine, endLine });

describe("pull-request review caller", () => {
  it("resolves checkout, base, and intent from the PR's declared lesscode-pr.json", async () => {
    const dir = await materializePr("8", { baseRef: "base", intent: ["src/greet.ts"] });
    expect(readPrDeclaration(dir)).toEqual({ baseRef: "base", intent: ["src/greet.ts"] });
  }, 300_000);

  it("rejects a missing or invalid declaration before any run", async () => {
    const missing = await materializePr("8", undefined);
    expect(() => readPrDeclaration(missing)).toThrow(/cannot read/);
    const bad = await materializePr("8", { baseRef: "base", intent: [] });
    expect(() => readPrDeclaration(bad)).toThrow(/invalid/);
    await expect(runPrReview({ checkout: bad })).rejects.toThrow(/invalid/);
  }, 300_000);

  it("accepted fixture: check body is the gate from review() and the comment is the review note", async () => {
    const intent = ["src/greet.ts"];
    const dir = await materializePr("8", { baseRef: "base", intent });
    const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout;
    const statusBefore = (await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout;
    const greetBefore = readFileSync(join(dir, "src/greet.ts"), "utf8");

    const spark = [
      { category: "convention-break", file: "src/greet.ts", convention: "no-console-log", citations: [cite("src/greet.ts", 2, 2)], rationale: "console.log in source" },
    ];
    const wonder = [
      { findingIndex: 0, action: "convention-fix", newFiles: [], deleteFiles: [], rationale: "code applies the mechanical fix" },
    ];
    const note = [
      { kind: "practice", text: "console.log does not belong in greet; the registry fix was applied mechanically.", citations: [cite("src/greet.ts", 2, 2)] },
    ];
    const { client, state } = scripted(spark, wonder, note);

    const viaPr = await runPrReview({ checkout: dir, sparkClient: client, wonderClient: client });
    const direct = await review({ checkout: dir, base: "base", intent, sparkClient: client, wonderClient: client });

    // Same review() result either way; the PR caller adds no pipeline.
    // LES-26: manifest timing differs per run; everything else identical.
    const { manifest: _dm, summary: _ds, run: _dr, ...directRest } = direct;
    const { manifest: _pm, summary: _ps, run: _pr, ...prRest } = viaPr.result;
    void _dm; void _ds; void _pm; void _ps; void _dr; void _pr;
    expect(prRest).toEqual(directRest);
    expect(viaPr.result.manifest?.promptHashes).toEqual(direct.manifest?.promptHashes);
    expect(viaPr.declaration).toEqual({ baseRef: "base", intent });
    expect(state.wonderCalls).toBe(2); // one Wonder call per review() run

    // Accepted: the patch is returned for the caller, the gate accepted.
    expect(viaPr.result.verdict).toBe("accepted");
    expect(viaPr.result.applied).toContain("-  console.log(name);");
    expect(viaPr.result.gate?.accepted).toBe(true);

    // The check body is exactly the gate from review(); the
    // conclusion comes from the gate alone.
    expect(viaPr.check).toEqual(gateCheck(direct));
    expect(viaPr.check.name).toBe("lesscode/review");
    expect(viaPr.check.conclusion).toBe("success");
    expect(viaPr.check.body).toBe(JSON.stringify(direct.gate));
    expect(JSON.parse(viaPr.check.body)).toEqual(direct.gate);

    // The comment is exactly the review note markdown — not the gate,
    // not the patch — and carries no conclusion.
    expect(viaPr.comment).toEqual(noteComment(direct));
    expect(viaPr.comment.body).toBe(direct.review.markdown);
    expect(viaPr.comment.body).toContain("## Lead review");
    expect(viaPr.comment.body).toContain("src/greet.ts:2-2");
    expect(viaPr.comment).not.toHaveProperty("conclusion");

    // The caller does not apply the patch and does not modify the PR branch.
    expect(readFileSync(join(dir, "src/greet.ts"), "utf8")).toBe(greetBefore);
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout).toBe(headBefore);
    expect((await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout).toBe(statusBefore);
  }, 300_000);

  it("reviewed-only fixture: the note is the comment and the check still carries the gate alone", async () => {
    const intent = ["src/report.ts"];
    const dir = await materializePr("7", { baseRef: "base", intent });
    const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout;
    const statusBefore = (await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout;

    const note = [
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
    ];
    const { client } = scripted([], [], note);

    const viaPr = await runPrReview({ checkout: dir, sparkClient: client, wonderClient: client });
    const direct = await review({ checkout: dir, base: "base", intent, sparkClient: client, wonderClient: client });

    // LES-26: manifest timing differs per run; everything else identical.
    const { manifest: _dm, summary: _ds, run: _dr, ...directRest } = direct;
    const { manifest: _pm, summary: _ps, run: _pr, ...prRest } = viaPr.result;
    void _dm; void _ds; void _pm; void _ps; void _dr; void _pr;
    expect(prRest).toEqual(directRest);
    expect(viaPr.result.manifest?.promptHashes).toEqual(direct.manifest?.promptHashes);
    expect(viaPr.declaration).toEqual({ baseRef: "base", intent });

    // Reviewed-only is a success: the note is the result, nothing applied.
    expect(viaPr.result.verdict).toBe("reviewed");
    expect(viaPr.result.applied).toBe("");
    expect(viaPr.result.review.items).toHaveLength(1);

    // The comment is exactly the review note (the invalid citation
    // was already dropped by review()'s code filter).
    expect(viaPr.comment.body).toBe(direct.review.markdown);
    expect(viaPr.comment.body).toContain("renderReceipt re-derives");
    expect(viaPr.comment.body).toContain("src/report.ts:5-10");
    expect(viaPr.comment.body).not.toContain("invented");
    expect(viaPr.comment).not.toHaveProperty("conclusion");

    // The check body is still exactly the gate from review() — for a
    // note-only run the gate is null, so the check fails even though
    // the note is a good review. The note cannot satisfy branch
    // protection; only a gate that ran and accepted can.
    const { manifest: _vm, summary: _vs, run: _vr, ...viaRest } = viaPr.result;
    void _vm; void _vs; void _vr;
    expect({ declaration: viaPr.declaration, result: viaRest, check: viaPr.check, comment: viaPr.comment }).toEqual({ declaration: viaPr.declaration, result: directRest, ...postFor(direct) });
    expect(viaPr.check.body).toBe(JSON.stringify(direct.gate));
    expect(viaPr.check.body).toBe("null");
    expect(viaPr.check.conclusion).toBe("failure");

    // Branch untouched, patch not applied.
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout).toBe(headBefore);
    expect((await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout).toBe(statusBefore);
  }, 300_000);
});
