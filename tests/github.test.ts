import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { GuestClient } from "../src/classify/client.js";
import { COMMENT_MARKER, runGithubPrReview, type GithubApi, type GithubRequest } from "../src/pr/index.js";
import { exactSuggestions } from "../src/pr/github.js";
import type { ReviewResult } from "../src/review/index.js";
import type { RepositoryExecutor } from "../src/execution/index.js";
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
  constructor(public headSha: string, public baseSha: string) {}
  async publisherIdentity() { return { actorId: 303, appId: 501 }; }
  async request(req: GithubRequest) {
    this.calls.push(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (req.method === "GET" && /\/pulls\/\d+$/.test(req.path)) return { status: 200, body: { head: { sha: this.headSha, ref: "bloated-pr" }, base: { ref: "base", sha: this.baseSha } } };
    if (req.method === "GET" && req.path.includes("/check-runs")) return { status: 200, body: { check_runs: this.checkRuns } };
    if (req.method === "POST" && req.path.endsWith("/check-runs")) { const r = { id: 101, app: { id: 501 }, ...b }; this.checkRuns = [r]; return { status: 201, body: r }; }
    if (req.method === "PATCH" && req.path.includes("/check-runs/")) { const r = { ...(this.checkRuns[0] ?? {}), ...b, id: 101 }; this.checkRuns = [r]; return { status: 200, body: r }; }
    if (req.method === "GET" && req.path.includes("/comments")) return { status: 200, body: this.comments };
    if (req.method === "POST" && /\/issues\/\d+\/comments$/.test(req.path)) { const r = { id: 202, user: { id: 303 }, ...b }; this.comments = [r]; return { status: 201, body: r }; }
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
    const api = new StubGithub(headSha, (await exec("git", ["rev-parse", "base"], { cwd: dir })).stdout.trim());

    const out = await runGithubPrReview({ api, owner: "Mariotutal", repo: "lesscode", prNumber: 99, checkout: dir, remoteUrl: bare, sparkClient: client, wonderClient: client, offer: "branch" });
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
    expect(out.patchOffer.branch).toMatch(new RegExp(`^lesscode/suggestions-pr-99-${headSha.slice(0, 12)}-`));
    expect(out.patchOffer.patch).toContain("-  console.log(name);");
    const branches = (await exec("git", ["--git-dir", bare, "branch", "--format=%(refname:short)"])).stdout;
    expect(branches).toContain("lesscode/suggestions-pr-99");
    expect(branches).not.toContain("bloated-pr");
    const suggested = (await exec("git", ["--git-dir", bare, "show", `${out.patchOffer.branch}:src/greet.ts`])).stdout;
    expect(suggested).not.toContain("console.log");
    // PR branch/checkout unchanged.
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout).toBe(headBefore);
    expect(readFileSync(join(dir, "src/greet.ts"), "utf8")).toBe(greetBefore);
    // Never merged / no PR-branch push, no merge API call.
    expect(api.calls.some((c) => c.path.includes("/merge"))).toBe(false);

    // Re-run updates the same check + comment, does not duplicate.
    const out2 = await runGithubPrReview({ api, owner: "Mariotutal", repo: "lesscode", prNumber: 99, checkout: dir, remoteUrl: bare, sparkClient: client, wonderClient: client, offer: "none" });
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
    const api = new StubGithub(headBefore.trim(), (await exec("git", ["rev-parse", "base"], { cwd: dir })).stdout.trim());
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

const smallRoots: string[] = [];
afterEach(() => { for (const path of smallRoots.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function smallCheckout(docsOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "lc-gh-identity-")); smallRoots.push(root);
  const checkout = join(root, "checkout"); mkdirSync(checkout);
  await sh(checkout, "git", ["init", "-q", "-b", "base"]);
  writeFileSync(join(checkout, "a.ts"), "export const a = 1;\n");
  await sh(checkout, "git", ["add", "."]);
  await sh(checkout, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"]);
  const baseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
  await sh(checkout, "git", ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(checkout, docsOnly ? "README.md" : "a.ts"), docsOnly ? "docs\n" : "export const a = 2;\n");
  await sh(checkout, "git", ["add", "."]);
  await sh(checkout, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "head"]);
  const headSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
  writeFileSync(join(checkout, PR_DECLARATION_FILE), JSON.stringify({ baseRef: "base", intent: ["a.ts"] }));
  return { root, checkout, headSha, baseSha, api: new StubGithub(headSha, baseSha) };
}
function noteOnlyResult(): ReviewResult {
  return {
    applied: "", review: { items: [], markdown: "" }, verdict: "reviewed", findings: [], gate: null, manifest: null, summary: "No changes needed",
    detail: { reasons: [], droppedFindings: 0, recoveredFindings: [], registry: [], unknownConventions: [], tsConfig: { allowJs: false, checkJs: false } },
  };
}
const isolatedNoCommands: RepositoryExecutor = {
  kind: "docker", async prepare() { throw new Error("unexpected repository setup"); }, async run() { throw new Error("unexpected repository command"); }, runSync() { throw new Error("unexpected repository command"); }, async dispose() {},
};

describe("revision-bound GitHub publication", () => {
  it("refuses a stale local checkout before review or publication", async () => {
    const fixture = await smallCheckout(); fixture.api.headSha = fixture.baseSha;
    let reviews = 0;
    await expect(runGithubPrReview({ api: fixture.api, owner: "o", repo: "r", prNumber: 1, checkout: fixture.checkout, reviewChange: async () => { reviews++; return noteOnlyResult(); } })).rejects.toThrow(/HEAD does not match/);
    expect(reviews).toBe(0);
    expect(fixture.api.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });
  it("does not publish a review when the pull request advances during the engine run", async () => {
    const fixture = await smallCheckout();
    await expect(runGithubPrReview({ api: fixture.api, owner: "o", repo: "r", prNumber: 1, checkout: fixture.checkout, reviewChange: async () => { fixture.api.headSha = fixture.baseSha; return noteOnlyResult(); } })).rejects.toThrow(/changed during review/);
    expect(fixture.api.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });
  it("publishes a create-only suggestion branch pinned to the reviewed SHA without changing the PR branch", async () => {
    const fixture = await smallCheckout();
    const remote = join(fixture.root, "remote.git");
    await sh(fixture.root, "git", ["init", "-q", "--bare", remote]);
    const blob = (await exec("git", ["rev-parse", `${fixture.headSha}:a.ts`], { cwd: fixture.checkout })).stdout.trim();
    await sh(fixture.checkout, "git", ["update-index", "--add", "--cacheinfo", "100644", blob, "sealed/harness.ts"]);
    const tree = (await exec("git", ["write-tree"], { cwd: fixture.checkout })).stdout.trim();
    fixture.headSha = (await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit-tree", tree, "-p", fixture.headSha, "-m", "harness metadata"], { cwd: fixture.checkout })).stdout.trim();
    await sh(fixture.checkout, "git", ["update-ref", "HEAD", fixture.headSha]); fixture.api.headSha = fixture.headSha;
    expect(existsSync(join(fixture.checkout, "sealed"))).toBe(false);
    const result = noteOnlyResult();
    result.verdict = "accepted";
    result.applied = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const a = 2;\n+export const a = 3;\n";
    result.gate = { accepted: true, checks: [], metrics: { sizeBefore: 2, sizeAfter: 1, cyclomaticBefore: 1, cyclomaticAfter: 1, changedFunctions: [] }, exitCodes: { tests: 0, tsc: 0, eslint: 0 } };
    const indexPath = join(fixture.checkout, ".git/index"), indexBefore = readFileSync(indexPath);
    const candidate = join(fixture.root, "candidate.ts"); writeFileSync(candidate, "export const a = 3;\n");
    const candidateBlob = (await exec("git", ["hash-object", "-w", candidate], { cwd: fixture.checkout })).stdout.trim();
    await sh(fixture.checkout, "git", ["update-index", "--cacheinfo", "100644", candidateBlob, "a.ts"]);
    const expectedTree = (await exec("git", ["write-tree"], { cwd: fixture.checkout })).stdout.trim();
    writeFileSync(indexPath, indexBefore);
    const out = await runGithubPrReview({ api: fixture.api, owner: "o", repo: "r", prNumber: 1, checkout: fixture.checkout, remoteUrl: remote, offer: "branch", reviewChange: async () => result });
    expect((await exec("git", ["--git-dir", remote, "rev-parse", `${out.patchOffer.branch}^{tree}`])).stdout.trim()).toBe(expectedTree);
    expect(out.patchOffer.branch).toMatch(new RegExp(`^lesscode/suggestions-pr-1-${fixture.headSha.slice(0, 12)}-`));
    const parent = (await exec("git", ["--git-dir", remote, "rev-parse", `${out.patchOffer.branch}^`])).stdout.trim();
    expect(parent).toBe(fixture.headSha);
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: fixture.checkout })).stdout.trim()).toBe(fixture.headSha);
    expect(readFileSync(join(fixture.checkout, "a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect((await exec("git", ["--git-dir", remote, "show", `${out.patchOffer.branch}:a.ts`])).stdout).toBe("export const a = 3;\n");
  });
  it("rejects a superseded queued head before loading or reviewing it", async () => {
    const fixture = await smallCheckout(); let reviews = 0;
    await expect(runGithubPrReview({ api: fixture.api, owner: "o", repo: "r", prNumber: 1, checkout: fixture.checkout, expectedHeadSha: fixture.baseSha, reviewChange: async () => { reviews++; return noteOnlyResult(); } })).rejects.toThrow(/queued review revision/);
    expect(reviews).toBe(0); expect(fixture.api.calls).toHaveLength(1);
  });
  it("can return an artifact for a hosted worker without publishing any external changes", async () => {
    const fixture = await smallCheckout();
    const out = await runGithubPrReview({ api: fixture.api, owner: "o", repo: "r", prNumber: 1, checkout: fixture.checkout, publish: false, offer: "branch", reviewChange: async () => noteOnlyResult() });
    expect(out.check.action).toBe("not-published"); expect(out.comment.action).toBe("not-published");
    expect(out.patchOffer.kind).toBe("none"); expect(out.result?.verdict).toBe("reviewed");
    expect(fixture.api.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    expect(fixture.api.calls.some((call) => /check-runs|comments/.test(call.path))).toBe(false);
  });
  it("does not edit comments or checks that merely copy our marker or name", async () => {
    const fixture = await smallCheckout();
    fixture.api.checkRuns = [{ id: 999, name: "lesscode/review", app: { id: 999 } }];
    fixture.api.comments = [{ id: 999, body: `${COMMENT_MARKER}\nspoofed`, user: { id: 999 } }];
    const out = await runGithubPrReview({ api: fixture.api, owner: "o", repo: "r", prNumber: 1, checkout: fixture.checkout, reviewChange: async () => noteOnlyResult() });
    expect(out.check.action).toBe("created"); expect(out.comment.action).toBe("created");
    expect(fixture.api.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });
  it("requires isolated execution for automatically fetched pull requests", async () => {
    const fixture = await smallCheckout();
    await expect(runGithubPrReview({ api: fixture.api, owner: "o", repo: "r", prNumber: 1 })).rejects.toThrow(/isolated Docker/);
    expect(fixture.api.calls).toHaveLength(0);
  });
  it("loads docs-only PRs without a declaration, makes no model calls, and disposes source after publication", async () => {
    const fixture = await smallCheckout(true);
    const remote = join(fixture.root, "remote.git");
    await sh(fixture.root, "git", ["init", "-q", "--bare", remote]);
    await sh(fixture.checkout, "git", ["push", "-q", remote, "base:refs/heads/base", "HEAD:refs/pull/1/head"]);
    let checkout = "", modelCalls = 0;
    const client: GuestClient = { config: { model: "scripted", apiKey: "stub", baseUrl: "stub" }, async chat() { modelCalls++; throw new Error("docs must not call a model"); } };
    const out = await runGithubPrReview({ api: fixture.api, owner: "o", repo: "r", prNumber: 1, remoteUrl: remote, executor: isolatedNoCommands, sparkClient: client, wonderClient: client,
      reviewChange: async (options) => { checkout = options.checkout; expect(existsSync(checkout)).toBe(true); expect(options.intent).toEqual([]); expect(options.base).toBe(fixture.baseSha); return noteOnlyResult(); },
    });
    expect(out.verdict).toBe("reviewed"); expect(out.patchOffer.patch).toBe(""); expect(modelCalls).toBe(0);
    expect(existsSync(checkout)).toBe(false);
    expect(fixture.api.checkRuns).toHaveLength(1); expect(fixture.api.comments).toHaveLength(1);
  });
  it("cleans up automatically fetched sources when review fails", async () => {
    const fixture = await smallCheckout();
    const remote = join(fixture.root, "remote.git");
    await sh(fixture.root, "git", ["init", "-q", "--bare", remote]);
    await sh(fixture.checkout, "git", ["push", "-q", remote, "base:refs/heads/base", "HEAD:refs/pull/1/head"]);
    let checkout = "";
    await expect(runGithubPrReview({ api: fixture.api, owner: "o", repo: "r", prNumber: 1, remoteUrl: remote, executor: isolatedNoCommands,
      reviewChange: async (options) => { checkout = options.checkout; throw new Error("model failed"); },
    })).rejects.toThrow(/model failed/);
    expect(existsSync(checkout)).toBe(false);
    expect(fixture.api.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });
});

describe("exact GitHub suggestions", () => {
  it("anchors multi-line replacement ranges to original PR lines, including surrounding context", () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -8,5 +8,4 @@\n context\n-old one\n-old two\n+new one\n more context\n last context\n";
    const result = exactSuggestions(patch);
    expect(result.unsupportedReason).toBeUndefined();
    expect(result.comments).toEqual([{ path: "a.ts", start_line: 9, line: 10, start_side: "RIGHT", side: "RIGHT", body: "LessCode verified replacement:\n\n```suggestion\nnew one\n```" }]);
  });
  it("refuses file deletion and pure insertion instead of creating misleading suggestions", () => {
    expect(exactSuggestions("diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n").comments).toEqual([]);
    expect(exactSuggestions("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n old\n+new\n").unsupportedReason).toMatch(/insertion/);
  });
});
