import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ReviewOptions } from "../review/index.js";
import { runPrReview } from "./pr.js";
import type { PrReviewCheck, PrReviewComment } from "./schema.js";

/**
 * GitHub hosting layer for the PR caller. src/pr/pr.ts only *returns*
 * the check/comment bodies; this module posts them.
 *
 * Given a pull request (owner/repo, number, head sha):
 *  - reads the PR via the API to find its head sha and checkout hint,
 *    then resolves base+intent from the checkout's lesscode-pr.json
 *    (runPrReview -> review(), exactly once);
 *  - creates or updates ONE Check Run named lesscode/review: body is
 *    the gate JSON (check.body), conclusion from the gate alone;
 *  - creates or updates ONE comment whose body is exactly the note.
 *    A marker line identifies our comment so re-runs update in place.
 *  - offers the accepted patch, chosen by the caller:
 *      "branch"      — commits the patch onto a NEW suggestion branch
 *                      (never the PR branch) in a scratch clone/worktree;
 *      "suggestions" — posts one review comment per contiguous patched
 *                      hunk as GitHub suggestion blocks (a review, not
 *                      a merge; it carries no check conclusion);
 *      "none"        — returns the patch text only.
 * Never pushes/applies to the PR branch, never merges, never lets the
 * note comment satisfy branch protection (only the Check Run does).
 *
 * The API surface is injected (`GithubApi`) so tests drive a stub and
 * no real post to Mariotutal/lesscode ever happens in tests.
 */
const exec = promisify(execFile);
export const COMMENT_MARKER = "<!-- lesscode:review-note -->";
export const CHECK_NAME = "lesscode/review" as const;

export interface GithubRequest { method: string; path: string; body?: unknown }
export interface GithubResponse { status: number; body: unknown }
export type GithubTransport = (req: GithubRequest) => Promise<GithubResponse>;
export interface GithubApi {
  request(req: GithubRequest): Promise<GithubResponse>;
}

/** Real transport: GitHub REST via fetch. Token from env, never logged. */
export function createGithubApi(opts: { token: string; baseUrl?: string; fetchFn?: typeof fetch }): GithubApi {
  const base = (opts.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const doFetch = opts.fetchFn ?? fetch;
  return {
    async request(req) {
      const res = await doFetch(`${base}${req.path}`, {
        method: req.method,
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${opts.token}`, "content-type": "application/json", "x-github-api-version": "2022-11-28" },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      });
      const text = await res.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (res.status >= 400) throw new Error(`GitHub ${req.method} ${req.path} failed: ${res.status} ${typeof body === "object" && body && "message" in body ? String((body as { message: unknown }).message) : ""}`.trim());
      return { status: res.status, body };
    },
  };
}

export type PatchOffer = "branch" | "suggestions" | "none";

export interface GithubPrReviewOptions {
  api: GithubApi;
  owner: string;
  repo: string;
  prNumber: number;
  /** Local checkout of the PR head (carries lesscode-pr.json). */
  checkout: string;
  offer?: PatchOffer;
  /** Suggestion branch name; default lesscode/suggestions-pr-<n>. */
  suggestionBranch?: string;
  sparkClient?: ReviewOptions["sparkClient"];
  wonderClient?: ReviewOptions["wonderClient"];
  /** Seam for tests / alternate runners of the one review() call. Defaults to runPrReview. */
  runReview?: typeof runPrReview;
}

export interface GithubPrReviewOutcome {
  check: PrReviewCheck & { id: number; action: "created" | "updated" };
  comment: PrReviewComment & { id: number; action: "created" | "updated" };
  patchOffer: { kind: PatchOffer; branch?: string; suggestions?: number; patch: string };
  prHeadSha: string;
  verdict: string;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" ? v as Obj : {});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Split a unified diff into per-file contiguous hunks for suggestion comments. */
export function patchHunks(patch: string): { path: string; startLine: number; lines: string[] }[] {
  const hunks: { path: string; startLine: number; lines: string[] }[] = [];
  let path = ""; let cur: { path: string; startLine: number; lines: string[] } | null = null;
  for (const line of patch.split("\n")) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) { path = f[1]!; cur = null; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { cur = { path, startLine: Number(h[1]), lines: [] }; hunks.push(cur); continue; }
    if (cur && (line.startsWith("+") || line.startsWith(" ") || line.startsWith("-"))) cur.lines.push(line);
  }
  return hunks;
}

function suggestionBody(hunk: { path: string; startLine: number; lines: string[] }): string {
  const added = hunk.lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
  const removedCount = hunk.lines.filter((l) => l.startsWith("-")).length;
  // Suggestions can only replace removed/context lines; keep it simple:
  // only offer when the hunk replaces at least one removed line.
  void removedCount;
  return ["LessCode gate-accepted suggestion:", "", "```suggestion", ...added, "```"].join("\n");
}

export async function runGithubPrReview(opts: GithubPrReviewOptions): Promise<GithubPrReviewOutcome> {
  const { api, owner, repo, prNumber } = opts;
  const offer: PatchOffer = opts.offer ?? "branch";
  const slug = `${owner}/${repo}`;

  const prRes = await api.request({ method: "GET", path: `/repos/${slug}/pulls/${prNumber}` });
  const pr = asObj(prRes.body);
  const headSha = String(asObj(pr.head).sha ?? "");
  if (!headSha) throw new Error(`pull request ${slug}#${prNumber} has no head sha`);

  // Exactly one review run.
  const runReview = opts.runReview ?? runPrReview;
  const { result, check, comment } = await runReview({ checkout: opts.checkout, ...(opts.sparkClient ? { sparkClient: opts.sparkClient } : {}), ...(opts.wonderClient ? { wonderClient: opts.wonderClient } : {}) });
  const patch = result.applied;

  // --- Check Run: create or update the one named check for this head.
  const existingChecks = asObj((await api.request({ method: "GET", path: `/repos/${slug}/commits/${headSha}/check-runs?per_page=100` })).body);
  const checkRuns = Array.isArray(existingChecks.check_runs) ? existingChecks.check_runs as Obj[] : [];
  const priorCheck = checkRuns.find((c) => c.name === CHECK_NAME);
  const checkPayload = {
    name: CHECK_NAME, head_sha: headSha, status: "completed", conclusion: check.conclusion,
    output: { title: `LessCode review: ${check.conclusion}`, summary: check.body },
  };
  let checkId: number; let checkAction: "created" | "updated";
  if (priorCheck) {
    const r = await api.request({ method: "PATCH", path: `/repos/${slug}/check-runs/${String(priorCheck.id)}`, body: checkPayload });
    checkId = Number(asObj(r.body).id ?? priorCheck.id); checkAction = "updated";
  } else {
    const r = await api.request({ method: "POST", path: `/repos/${slug}/check-runs`, body: checkPayload });
    checkId = Number(asObj(r.body).id); checkAction = "created";
  }

  // --- Note comment: create or update the one marked comment. Body is
  // exactly the note plus our invisible marker (marker is not note text
  // shown to readers; stored body suffix keeps equality checkable by
  // stripping the marker).
  const commentBody = `${COMMENT_MARKER}\n${comment.body}`;
  const commentsRes = await api.request({ method: "GET", path: `/repos/${slug}/issues/${prNumber}/comments?per_page=100` });
  const comments = Array.isArray(commentsRes.body) ? commentsRes.body as Obj[] : [];
  const priorComment = comments.find((c) => typeof c.body === "string" && c.body.includes(COMMENT_MARKER));
  let commentId: number; let commentAction: "created" | "updated";
  if (priorComment) {
    const r = await api.request({ method: "PATCH", path: `/repos/${slug}/issues/comments/${String(priorComment.id)}`, body: { body: commentBody } });
    commentId = Number(asObj(r.body).id ?? priorComment.id); commentAction = "updated";
  } else {
    const r = await api.request({ method: "POST", path: `/repos/${slug}/issues/${prNumber}/comments`, body: { body: commentBody } });
    commentId = Number(asObj(r.body).id); commentAction = "created";
  }

  // --- Patch offer. Never touches the PR branch.
  const outcome: GithubPrReviewOutcome = {
    check: { ...check, id: checkId, action: checkAction },
    comment: { ...comment, id: commentId, action: commentAction },
    patchOffer: { kind: offer, patch },
    prHeadSha: headSha,
    verdict: result.verdict,
  };
  if (!patch || offer === "none") return outcome;

  if (offer === "suggestions") {
    const commentsForReview = patchHunks(patch)
      .filter((h) => h.lines.some((l) => l.startsWith("-")))
      .map((h) => ({ path: h.path, line: h.startLine, side: "RIGHT", body: suggestionBody(h) }));
    if (commentsForReview.length) {
      await api.request({ method: "POST", path: `/repos/${slug}/pulls/${prNumber}/reviews`, body: { commit_id: headSha, event: "COMMENT", comments: commentsForReview } });
    }
    outcome.patchOffer.suggestions = commentsForReview.length;
    return outcome;
  }

  // offer === "branch": apply patch in a scratch clone, commit to a NEW
  // branch, push only that branch. PR head branch never referenced.
  const branch = opts.suggestionBranch ?? `lesscode/suggestions-pr-${prNumber}`;
  const tmp = mkdtempSync(join(tmpdir(), "lc-gh-"));
  try {
    const scratch = join(tmp, "repo");
    await git(opts.checkout, ["worktree", "add", "-q", "--detach", scratch, "HEAD"]).catch(async () => {
      // Fallback for non-worktree-friendly checkouts: local clone.
      await exec("git", ["clone", "-q", "--no-hardlinks", opts.checkout, scratch]);
    });
    try {
      const patchFile = join(tmp, "applied.patch");
      writeFileSync(patchFile, patch);
      await exec("git", ["apply", patchFile], { cwd: scratch });
      await git(scratch, ["checkout", "-q", "-b", branch]);
      await git(scratch, ["add", "-A"]);
      await exec("git", ["-c", "user.email=lesscode@localhost", "-c", "user.name=LessCode", "commit", "-qm", `LessCode gate-accepted patch for PR #${prNumber} (suggestion only; not applied to the PR branch)`], { cwd: scratch });
      // Push only the suggestion branch to the repo the stub/real API
      // represents when a github remote exists; tests use a local bare
      // remote named origin in the checkout. If no origin, keep commit
      // local and report the branch (caller can push).
      const remotes = await git(scratch, ["remote"]).catch(() => "");
      if (remotes.split("\n").includes("origin")) await git(scratch, ["push", "-q", "origin", branch]);
    } finally {
      await exec("git", ["worktree", "remove", "--force", scratch], { cwd: opts.checkout }).catch(() => undefined);
      void readFileSync; // (patch file lives under tmp, removed below)
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  outcome.patchOffer.branch = branch;
  return outcome;
}
