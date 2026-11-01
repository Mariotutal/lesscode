import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { GuestClient } from "../src/classify/client.js";
import { COMMENT_MARKER, runGithubPrReview, type GithubApi, type GithubRequest } from "../src/pr/index.js";
import { PR_DECLARATION_FILE } from "../src/pr/index.js";
import { parseArgs, exitCodeForVerdict, ArgError } from "../src/cli/args.js";

const exec = promisify(execFile);
const root = process.cwd();
async function sh(cwd: string, cmd: string, args: string[]) { await exec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }); }

function scripted(sparkFindings: unknown, wonderEdits: unknown, wonderReview: unknown = []) {
  const state = { wonderCalls: 0 };
  const client = {
    config: { baseUrl: "stub", apiKey: "stub", model: "scripted" },
    async chat(req: { tools?: { function: { name: string } }[] }) {
      const tool = req.tools?.[0]?.function.name ?? "";
      if (tool !== "report_findings") state.wonderCalls++;
      const payload = tool === "report_findings" ? { findings: sparkFindings } : tool === "repair_patch" ? { newFiles: [] } : { edits: wonderEdits, review: wonderReview };
      return { content: null, toolCalls: [{ id: "c1", type: "function" as const, function: { name: tool, arguments: JSON.stringify(payload) } }], finishReason: "tool_calls" };
    },
  } as unknown as GuestClient;
  return { client, state };
}

/** In-memory GitHub stub. Records every call; serves PR, checks, comments. */
class StubGithub implements GithubApi {
  calls: GithubRequest[] = [];
  checkRuns: Record<string, unknown>[] = [];
  comments: Record<string, unknown>[] = [];
  reviews: Record<string, unknown>[] = [];
  constructor(private headSha: string) {}
  async request(req: GithubRequest) {
    this.calls.push(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (req.method === "GET" && /\/pulls\/\d+$/.test(req.path)) return { status: 200, body: { head: { sha: this.headSha, ref: "bloated-pr" }, base: { ref: "base" } } };
    if (req.method === "GET" && req.path.includes("/check-runs")) return { status: 200, body: { check_runs: this.checkRuns } };
    if (req.method === "POST" && req.path.endsWith("/check-runs")) { const r = { id: 101, ...b }; this.checkRuns = [r]; return { status: 201, body: r }; }
    if (req.method === "PATCH" && req.path.includes("/check-runs/")) { const r = { ...(this.checkRuns[0] ?? {}), ...b, id: 101 }; this.checkRuns = [r]; return { status: 200, body: r }; }
    if (req.method === "GET" && req.path.includes("/comments")) return { status: 200, body: this.comments };
    if (req.method === "POST" && /\/issues\/\d+\/comments$/.test(req.path)) { const r = { id: 202, ...b }; this.comments = [r]; return { status: 201, body: r }; }
    if (req.method === "PATCH" && req.path.includes("/issues/comments/")) { const r = { ...(this.comments[0] ?? {}), ...b, id: 202 }; this.comments = [r]; return { status: 200, body: r }; }
    if (req.method === "POST" && req.path.endsWith("/reviews")) { this.reviews.push(b); return { status: 200, body: { id: 303 } }; }
    throw new Error(`stub: unexpected ${req.method} ${req.path}`);
  }
}

const cite = (file: string, s: number, e: number) => ({ file, startLine: s, endLine: e });

describe("GitHub PR caller (stubbed API)", () => {
  it("posts gate check + note comment, offers patch on a suggestion branch, PR branch unchanged; re-run updates in place", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-gh-test-"));
    const dir = join(tmp, "f");
    await sh(root, "bash", ["fixtures/scripts/materialize.sh", "8", dir]);
    await sh(dir, "npm", ["install", "--no-audit", "--no-fund", "--silent"]);
    await sh(dir, "git", ["checkout", "-q", "bloated-pr"]);
    writeFileSync(join(dir, PR_DECLARATION_FILE), JSON.stringify({ baseRef: "base", intent: ["src/greet.ts"] }));
    // Bare origin so the suggestion-branch push has somewhere stub-local to go (not GitHub).
    const bare = join(tmp, "origin.git");
    await sh(tmp, "git", ["init", "-q", "--bare", bare]);
    await sh(dir, "git", ["remote", "add", "origin", bare]);
    const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout;
    const greetBefore = readFileSync(join(dir, "src/greet.ts"), "utf8");

    const spark = [{ category: "convention-break", file: "src/greet.ts", convention: "no-console-log", citations: [cite("src/greet.ts", 2, 2)], rationale: "console.log in source" }];
    const wonder = [{ findingIndex: 0, action: "convention-fix", newFiles: [], deleteFiles: [], rationale: "code applies the mechanical fix" }];
    const note = [{ kind: "practice", text: "console.log does not belong in greet; the registry fix was applied mechanically.", citations: [cite("src/greet.ts", 2, 2)] }];
    const { client, state } = scripted(spark, wonder, note);
    const headSha = headBefore.trim();
    const api = new StubGithub(headSha);

    const out = await runGithubPrReview({ api, owner: "Mariotutal", repo: "lesscode", prNumber: 99, checkout: dir, sparkClient: client, wonderClient: client, offer: "branch" });
    expect(state.wonderCalls).toBe(1); // review() called once
    expect(out.verdict).toBe("accepted");
    // Check: conclusion from gate alone, body is gate JSON.
    expect(api.checkRuns).toHaveLength(1);
    const check = api.checkRuns[0] as { name: string; conclusion: string; output: { summary: string } };
    expect(check.name).toBe("lesscode/review");
    expect(check.conclusion).toBe("success");
    expect(check.output.summary).toBe(out.check.body);
    expect(JSON.parse(check.output.summary).accepted).toBe(true);
    expect(out.check.body).toContain('"accepted":true');
    // Comment: body (minus marker) equals the note exactly; no conclusion.
    expect(api.comments).toHaveLength(1);
    const posted = String((api.comments[0] as { body: string }).body);
    expect(posted.startsWith(COMMENT_MARKER)).toBe(true);
    expect(posted.slice(COMMENT_MARKER.length + 1)).toBe(out.comment.body);
    expect(out.comment.body).toContain("## Lead review");
    expect(api.comments[0]).not.toHaveProperty("conclusion");
    // Patch offered on suggestion branch, not applied to PR branch.
    expect(out.patchOffer.branch).toBe("lesscode/suggestions-pr-99");
    expect(out.patchOffer.patch).toContain("-  console.log(name);");
    const branches = (await exec("git", ["--git-dir", bare, "branch", "--format=%(refname:short)"])).stdout;
    expect(branches).toContain("lesscode/suggestions-pr-99");
    expect(branches).not.toContain("bloated-pr");
    const suggested = (await exec("git", ["--git-dir", bare, "show", "lesscode/suggestions-pr-99:src/greet.ts"])).stdout;
    expect(suggested).not.toContain("console.log");
    // PR branch/checkout unchanged.
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout).toBe(headBefore);
    expect(readFileSync(join(dir, "src/greet.ts"), "utf8")).toBe(greetBefore);
    // Never merged / no PR-branch push, no merge API call.
    expect(api.calls.some((c) => c.path.includes("/merge"))).toBe(false);

    // Re-run updates the same check + comment, does not duplicate.
    const out2 = await runGithubPrReview({ api, owner: "Mariotutal", repo: "lesscode", prNumber: 99, checkout: dir, sparkClient: client, wonderClient: client, offer: "none" });
    expect(out2.check.action).toBe("updated");
    expect(out2.comment.action).toBe("updated");
    expect(api.checkRuns).toHaveLength(1);
    expect(api.comments).toHaveLength(1);
  }, 300_000);

  it("reviewed-only: check conclusion follows the (null) gate = failure, comment is the note, no patch offered", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-gh-test7-"));
    const dir = join(tmp, "f");
    await sh(root, "bash", ["fixtures/scripts/materialize.sh", "7", dir]);
    await sh(dir, "npm", ["install", "--no-audit", "--no-fund", "--silent"]);
    await sh(dir, "git", ["checkout", "-q", "bloated-pr"]);
    writeFileSync(join(dir, PR_DECLARATION_FILE), JSON.stringify({ baseRef: "base", intent: ["src/report.ts"] }));
    const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout;
    const note = [{ kind: "boundary", text: "renderReceipt re-derives the invoice presentation instead of sharing the Invoice concept; formatting changes must be made in two places.", citations: [cite("src/report.ts", 5, 10)] }];
    const { client } = scripted([], [], note);
    const api = new StubGithub(headBefore.trim());
    const out = await runGithubPrReview({ api, owner: "o", repo: "r", prNumber: 7, checkout: dir, sparkClient: client, wonderClient: client, offer: "suggestions" });
    expect(out.verdict).toBe("reviewed");
    expect((api.checkRuns[0] as { conclusion: string }).conclusion).toBe("failure");
    expect(out.check.body).toBe("null");
    expect(String((api.comments[0] as { body: string }).body)).toContain("renderReceipt re-derives");
    expect(out.patchOffer.patch).toBe("");
    expect(api.reviews).toHaveLength(0);
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout).toBe(headBefore);
    expect(existsSync(join(dir, "src/report.ts"))).toBe(true);
  }, 300_000);
});

describe("unified CLI parser", () => {
  it("parses values, =values, lists, help; rejects unknown/missing", () => {
    const specs = [{ name: "repo", kind: "value" as const, required: true }, { name: "intent", kind: "list" as const }];
    const a = parseArgs(["--repo", "x", "--intent=a.ts, b.ts"], specs, "u");
    expect(a.values.get("repo")).toBe("x");
    expect(a.lists.get("intent")).toEqual(["a.ts", "b.ts"]);
    expect(parseArgs(["--help"], specs, "u").help).toBe(true);
    expect(() => parseArgs(["--nope", "1"], specs, "u")).toThrow(ArgError);
    expect(() => parseArgs([], specs, "u")).toThrow(/missing --repo/);
  });
  it("exit codes match simplify scheme: 0 accepted, 1 refused/reviewed, 2 failed", () => {
    expect(exitCodeForVerdict("accepted")).toBe(0);
    expect(exitCodeForVerdict("refused")).toBe(1);
    expect(exitCodeForVerdict("reviewed")).toBe(1);
    expect(exitCodeForVerdict("failed")).toBe(2);
  });
});
