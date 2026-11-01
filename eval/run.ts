import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GuestClient } from "../src/classify/client.js";
import { review, type ReviewResult } from "../src/review/review.js";
import { scoreCase, type CaseScore } from "./score.js";
import type { EvalCase } from "./types.js";

const exec = promisify(execFile);

/**
 * Shared case runner (LES-27) for the scripted test and the live
 * runner. Materializes a case into a throwaway git repo (base commit
 * = `base`, PR head = `head`), then calls review() exactly as a
 * caller would. The caller checkout is never the case directory.
 */
export async function materializeCase(repoRoot: string, c: EvalCase): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "lc-eval-"));
  const dir = join(parent, "repo");
  cpSync(join(repoRoot, c.dir, "base"), dir, { recursive: true });
  const git = (args: string[]) => exec("git", args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  await exec("git", ["init", "-q", "-b", "base", dir], { cwd: parent });
  await git(["add", "-A"]);
  await git(["-c", "user.email=eval@local", "-c", "user.name=eval", "commit", "-qm", "base"]);
  // head snapshot replaces the tree
  await git(["checkout", "-qb", "head"]);
  await git(["rm", "-rq", "."]);
  // cpSync head over dir, excluding .git
  cpSync(join(repoRoot, c.dir, "head"), dir, {
    recursive: true,
    filter: (src) => !src.endsWith(".git"),
  });
  await git(["add", "-A"]);
  await git(["-c", "user.email=eval@local", "-c", "user.name=eval", "commit", "-qm", "head"]);
  await exec("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  return dir;
}

export function cleanupCase(dir: string): void {
  rmSync(join(dir, ".."), { recursive: true, force: true });
}

/**
 * Scripted model: one stub serves Spark (report_findings) and Wonder
 * (one call returning edits + note). It also counts calls so tests
 * can prove Wonder was called exactly once. The script deliberately
 * includes the case's false positives; scoring separates reported
 * (script/Spark) from kept (post-verification result findings).
 */
export function scriptedClient(c: EvalCase): { client: GuestClient; wonderCalls: () => number; sparkReported: typeof c.spark } {
  let wonder = 0;
  const client = {
    config: { baseUrl: "stub", apiKey: "stub", model: "scripted" },
    async chat(req: { tools?: { function: { name: string } }[] }) {
      const tool = req.tools?.[0]?.function.name ?? "";
      if (tool !== "report_findings") wonder++;
      const payload =
        tool === "report_findings"
          ? { findings: c.spark }
          : tool === "repair_patch"
            ? { newFiles: [] }
            : { edits: c.wonder.map((w) => ({ ...w, newFiles: [], deleteFiles: [] })), review: c.wonderReview };
      return {
        content: null,
        toolCalls: [{ id: "c1", type: "function" as const, function: { name: tool, arguments: JSON.stringify(payload) } }],
        finishReason: "tool_calls",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    },
  } as unknown as GuestClient;
  return { client, wonderCalls: () => wonder, sparkReported: c.spark };
}

export async function runCase(repoRoot: string, c: EvalCase, clients: { spark: GuestClient; wonder: GuestClient }): Promise<{ score: CaseScore; result: ReviewResult; ms: number }> {
  const dir = await materializeCase(repoRoot, c);
  const t0 = performance.now();
  try {
    const result = await review({
      checkout: dir,
      base: "base",
      intent: c.intent,
      relatedTests: c.relatedTests,
      sparkClient: clients.spark,
      wonderClient: clients.wonder,
    });
    const ms = performance.now() - t0;
    const score = scoreCase({
      id: c.id,
      expected: c.expectedFindings,
      sparkReported: c.spark.map((f) => ({ category: f.category, file: f.file })),
      kept: result.findings.map((f) => ({ category: f.category, file: f.file })),
      expectedVerdict: c.expectedVerdict,
      actualVerdict: result.verdict,
      modelCalls: result.manifest?.modelCalls ?? 0,
      tokens: result.manifest?.usage.total_tokens ?? 0,
      ms,
    });
    return { score, result, ms };
  } finally {
    cleanupCase(dir);
  }
}
