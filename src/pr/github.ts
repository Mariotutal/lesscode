import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { review, type ReviewOptions, type ReviewResult } from "../review/index.js";
import type { RunRecord } from "../engine/types.js";
import { loadLocalChange } from "../source/local.js";
import { loadPullRequest, readPullRequest } from "../source/pullRequest.js";
import type { LoadedChange, PullRequestIdentity } from "../source/change.js";
import { diffPaths, excludeHarnessPaths, sourceGit } from "../source/git.js";
import { postFor, readPrDeclaration, runPrReview } from "./pr.js";
import type { PrReviewCheck, PrReviewComment } from "./schema.js";

export const COMMENT_MARKER = "<!-- lesscode:review-note -->";
export const CHECK_NAME = "lesscode/review" as const;

export interface GithubRequest { method: string; path: string; body?: unknown }
export interface GithubResponse { status: number; body: unknown }
export type GithubTransport = (req: GithubRequest) => Promise<GithubResponse>;
export interface PublisherIdentity { actorId?: number; appId?: number }
export interface GithubApi {
  request(req: GithubRequest): Promise<GithubResponse>;
  /** Used only by Git transport, never repository execution or model context. */
  gitEnvironment?(): NodeJS.ProcessEnv;
  publisherIdentity?(): Promise<PublisherIdentity>;
}

/** Credentials are held by this transport, never passed to repository commands. */
export function createGithubApi(opts: { token: string; baseUrl?: string; fetchFn?: typeof fetch; publisherActorId?: number; publisherAppId?: number }): GithubApi {
  const base = (opts.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const doFetch = opts.fetchFn ?? fetch;
  const apiHost = new URL(base).hostname;
  const gitHost = apiHost === "api.github.com" ? "github.com" : apiHost;
  let knownAppId = opts.publisherAppId;
  let identity: Promise<PublisherIdentity> | undefined;
  const api: GithubApi = {
    publisherIdentity() {
      identity ??= opts.publisherActorId || knownAppId
        ? Promise.resolve({ ...(opts.publisherActorId ? { actorId: opts.publisherActorId } : {}), ...(knownAppId ? { appId: knownAppId } : {}) })
        : api.request({ method: "GET", path: "/user" }).then((response) => {
          const id = asObj(response.body).id;
          if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new Error("GitHub publisher has no verified identity");
          return { actorId: id, ...(knownAppId ? { appId: knownAppId } : {}) };
        }).catch(() => { throw new Error("GitHub App publication requires publisherAppId; authenticated actor identity could not be established"); });
      return identity.then((value) => ({ ...value, ...(knownAppId ? { appId: knownAppId } : {}) }));
    },
    gitEnvironment: () => ({
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.https://${gitHost}/.extraheader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${opts.token}`).toString("base64")}`,
    }),
    async request(req) {
      const res = await doFetch(`${base}${req.path}`, {
        method: req.method, signal: AbortSignal.timeout(30_000),
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${opts.token}`, "content-type": "application/json", "x-github-api-version": "2022-11-28" },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      });
      const text = await res.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (res.status >= 400) throw new Error(`GitHub ${req.method} ${req.path} failed: ${res.status} ${typeof body === "object" && body && "message" in body ? String((body as { message: unknown }).message) : ""}`.trim());
      if (req.method === "POST" && req.path.endsWith("/check-runs")) {
        const appId = asObj(asObj(body).app).id;
        if (typeof appId === "number" && Number.isSafeInteger(appId) && appId > 0) knownAppId = appId;
      }
      return { status: res.status, body };
    },
  };
  return api;
}

export type PatchOffer = "branch" | "suggestions" | "none";
export interface GithubPrReviewOptions {
  api: GithubApi;
  owner: string;
  repo: string;
  prNumber: number;
  /** Prepared local adapter; omit to fetch a disposable PR checkout. */
  checkout?: string;
  /** Webhook/queue identity; reject superseded jobs before fetching source. */
  expectedHeadSha?: string;
  /** Explicit Git transport destination; defaults to the requested base repository. */
  remoteUrl?: string;
  offer?: PatchOffer;
  /** Hosted workers review first and publish only through a separate authorized step. */
  publish?: boolean;
  /** Explicit publisher identity for custom transports; never inferred from a marker. */
  publisherActorId?: number;
  suggestionBranch?: string;
  sparkClient?: ReviewOptions["sparkClient"];
  wonderClient?: ReviewOptions["wonderClient"];
  executor?: ReviewOptions["executor"];
  signal?: AbortSignal;
  /** Legacy local runner seam, retained for existing callers. */
  runReview?: typeof runPrReview;
  reviewChange?: typeof review;
}

export interface GithubPrReviewOutcome {
  check: PrReviewCheck & { id?: number; action: "created" | "updated" | "not-published" };
  comment: PrReviewComment & { id?: number; action: "created" | "updated" | "not-published" };
  patchOffer: { kind: PatchOffer; branch?: string; suggestions?: number; patch: string; unsupportedReason?: string };
  prHeadSha: string;
  verdict: string;
  run?: RunRecord;
  result?: ReviewResult;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => v && typeof v === "object" ? v as Obj : {};

/** Legacy parser retained for callers inspecting a diff; publication uses exact original ranges below. */
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

interface SuggestionComment { path: string; line: number; start_line?: number; side: "RIGHT"; start_side?: "RIGHT"; body: string }

/** Suggestions replace lines on the reviewed PR HEAD, the old side of the simplification diff. */
export function exactSuggestions(patch: string): { comments: SuggestionComment[]; unsupportedReason?: string } {
  const comments: SuggestionComment[] = [];
  let path = "", oldLine = 0, inHunk = false;
  let removed: string[] = [], added: string[] = [], firstRemoved = 0;
  let unsupportedReason: string | undefined;
  const flush = () => {
    if (!removed.length && !added.length) return;
    if (!removed.length || firstRemoved < 1 || !path) {
      unsupportedReason = "patch contains an insertion or file operation with no exact existing-line replacement; use the patch or suggestion branch";
    } else if (added.some((line) => line.includes("```"))) {
      unsupportedReason = "replacement contains a Markdown code fence; use the patch or suggestion branch";
    } else {
      const end = firstRemoved + removed.length - 1;
      comments.push({ path, line: end, side: "RIGHT", ...(end > firstRemoved ? { start_line: firstRemoved, start_side: "RIGHT" as const } : {}), body: ["LessCode verified replacement:", "", "```suggestion", ...added, "```"].join("\n") });
    }
    removed = []; added = []; firstRemoved = 0;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { flush(); path = ""; inHunk = false; }
    else if (line.startsWith("new file mode") || line.startsWith("deleted file mode") || line.startsWith("rename ") || line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      unsupportedReason = "patch contains a file addition, deletion, rename, or binary change; use the patch or suggestion branch";
    } else if (!inHunk && line.startsWith("+++ b/")) {
      path = line.slice(6);
      if (!path || path.startsWith("/") || path.split("/").includes("..") || /[\t\r\n"\\]/.test(path)) unsupportedReason = "patch path cannot be represented safely as a review suggestion";
    } else if (line.startsWith("@@ ")) {
      flush();
      const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!hunk) { unsupportedReason = "unrecognised patch hunk"; inHunk = false; }
      else { oldLine = Number(hunk[1]); inHunk = true; }
    } else if (inHunk && line.startsWith("-")) {
      if (added.length) flush();
      if (!removed.length) firstRemoved = oldLine;
      removed.push(line.slice(1)); oldLine++;
    } else if (inHunk && line.startsWith("+")) added.push(line.slice(1));
    else if (inHunk && line.startsWith(" ")) { flush(); oldLine++; }
    else if (line.startsWith("\\ No newline")) unsupportedReason = "patch changes final-newline semantics; use the patch or suggestion branch";
  }
  flush();
  return unsupportedReason ? { comments: [], unsupportedReason } : { comments };
}

async function allPages(api: GithubApi, path: string, key?: string): Promise<Obj[]> {
  const values: Obj[] = [];
  for (let page = 1; page <= 100; page++) {
    const response = await api.request({ method: "GET", path: `${path}?per_page=100&page=${page}` });
    const body = key ? asObj(response.body)[key] : response.body;
    if (!Array.isArray(body)) throw new Error("GitHub list response has no expected items");
    values.push(...body.map(asObj));
    if (body.length < 100) return values;
  }
  throw new Error("GitHub pagination exceeded the review publication limit");
}

async function offerBranch(checkout: string, identity: PullRequestIdentity, patch: string, requested: string | undefined, assertCurrent: () => Promise<void>, api: GithubApi, expectedTreeHash?: string): Promise<string> {
  const branch = requested ?? `lesscode/suggestions-pr-${identity.number}-${identity.headSha.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  if (branch === identity.headRef || branch === identity.baseRef || branch.startsWith("-")) throw new Error("suggestion branch must differ from the pull request and base branches");
  await sourceGit(checkout, ["check-ref-format", "--branch", branch]);
  const parent = mkdtempSync(join(tmpdir(), "lc-publish-"));
  try {
    const scratch = join(parent, "repo");
    await sourceGit(parent, ["clone", "-q", "--no-hardlinks", "--no-checkout", "--", checkout, scratch]);
    await excludeHarnessPaths(scratch);
    await sourceGit(scratch, ["checkout", "-q", "--detach", identity.headSha]);
    const patchFile = join(parent, "candidate.patch");
    writeFileSync(patchFile, patch);
    await sourceGit(scratch, ["apply", "--index", "--whitespace=nowarn", patchFile]);
    if (expectedTreeHash && (await sourceGit(scratch, ["write-tree"])).trim() !== expectedTreeHash) throw new Error("suggestion branch tree differs from the verified artifact");
    await sourceGit(scratch, ["-c", "user.email=lesscode@localhost", "-c", "user.name=LessCode", "commit", "-qm", `LessCode verified suggestion for PR #${identity.number} at ${identity.headSha}`]);
    const exists = await sourceGit(scratch, ["ls-remote", "--exit-code", "--heads", "--", identity.remoteUrl, `refs/heads/${branch}`], api.gitEnvironment?.()).then(() => true, (error: { code?: number }) => { if (error.code === 2) return false; throw error; });
    if (exists) throw new Error(`suggestion branch ${branch} already exists; choose a new branch name`);
    await assertCurrent();
    // An empty expected value makes this a create-only push, even if another worker races us.
    await sourceGit(scratch, ["push", "-q", `--force-with-lease=refs/heads/${branch}:`, "--", identity.remoteUrl, `HEAD:refs/heads/${branch}`], api.gitEnvironment?.());
    return branch;
  } finally { rmSync(parent, { recursive: true, force: true }); }
}

/** One immutable source revision, one engine run, then publication bound to that revision. */
export async function runGithubPrReview(opts: GithubPrReviewOptions): Promise<GithubPrReviewOutcome> {
  if (!opts.checkout && opts.executor?.kind !== "docker") throw new Error("fetched pull requests require an isolated Docker repository executor");
  const identity = await readPullRequest({ api: opts.api, owner: opts.owner, repo: opts.repo, number: opts.prNumber, remoteUrl: opts.remoteUrl });
  if (opts.expectedHeadSha && opts.expectedHeadSha !== identity.headSha) throw new Error("pull request head no longer matches the queued review revision");
  let loaded: LoadedChange;
  if (opts.checkout) {
    const declaration = readPrDeclaration(opts.checkout);
    if (declaration.baseRef !== identity.baseSha && declaration.baseRef !== identity.baseRef) throw new Error("local declaration baseRef does not match the pull request base");
    loaded = await loadLocalChange({ checkout: opts.checkout, base: identity.baseSha, intent: declaration.intent, relatedTests: declaration.relatedTests });
    if (loaded.change.headSha !== identity.headSha) throw new Error("local checkout HEAD does not match the pull request head SHA");
    loaded.change.comparisonBaseSha = (await sourceGit(loaded.change.checkout, ["merge-base", identity.baseSha, identity.headSha])).trim();
    loaded.change.changedFiles = await diffPaths(loaded.change.checkout, loaded.change.comparisonBaseSha, identity.headSha);
  } else loaded = await loadPullRequest({ api: opts.api, owner: opts.owner, repo: opts.repo, number: opts.prNumber, identity });
  try {
    const change = loaded.change;
    const clients = { ...(opts.sparkClient ? { sparkClient: opts.sparkClient } : {}), ...(opts.wonderClient ? { wonderClient: opts.wonderClient } : {}) };
    const result = opts.runReview && opts.checkout
      ? (await opts.runReview({ checkout: change.checkout, ...clients })).result
      : await (opts.reviewChange ?? review)({ checkout: change.checkout, base: change.comparisonBaseSha, intent: change.intent, scope: change.scope, expectedHeadSha: change.headSha, relatedTests: change.relatedTests, executor: opts.executor, signal: opts.signal, ...clients });
    if (result.verdict === "failed") throw new Error(result.detail.error ?? "review failed before publication");
    if (result.applied && (result.verdict !== "accepted" || !result.gate?.accepted)) throw new Error("refusing to publish a patch without accepted verification");
    if (result.run) {
      if (result.run.revision?.headSha !== identity.headSha || result.run.revision.baseSha !== change.comparisonBaseSha) throw new Error("review result belongs to a different source revision");
      if (result.applied) {
        const artifact = result.run.artifact;
        if (!artifact || artifact.patch !== result.applied || artifact.headSha !== identity.headSha || artifact.baseSha !== change.comparisonBaseSha || artifact.sha256 !== createHash("sha256").update(result.applied).digest("hex") || result.run.verification.status !== "verified" || artifact.treeHash !== result.run.verification.treeHash) throw new Error("review artifact does not match its verification evidence");
      }
    }
    const { check, comment } = postFor(result);
    const slug = `${opts.owner}/${opts.repo}`, offer = opts.offer ?? "none";
    const assertCurrent = async () => {
      opts.signal?.throwIfAborted();
      const now = await readPullRequest({ api: opts.api, owner: opts.owner, repo: opts.repo, number: opts.prNumber, remoteUrl: opts.remoteUrl });
      if (now.headSha !== identity.headSha || now.baseSha !== identity.baseSha) throw new Error("pull request changed during review; result was not published to the new revision");
    };
    await assertCurrent();
    if (opts.publish === false) return {
      check: { ...check, action: "not-published" }, comment: { ...comment, action: "not-published" },
      patchOffer: { kind: "none", patch: result.applied }, prHeadSha: identity.headSha, verdict: result.verdict,
      ...(result.run ? { run: result.run } : {}), result,
    };
    const publisher = opts.publisherActorId ? { actorId: opts.publisherActorId } : await opts.api.publisherIdentity?.();
    if (publisher && [publisher.actorId, publisher.appId].some((id) => id !== undefined && (!Number.isSafeInteger(id) || id < 1))) throw new Error("invalid publisher identity");
    const ownedByPublisher = (item: Obj): boolean => Boolean(publisher && ((publisher.appId && (asObj(item.app).id === publisher.appId || asObj(item.performed_via_github_app).id === publisher.appId)) || (publisher.actorId && (asObj(item.user).id === publisher.actorId || asObj(item.creator).id === publisher.actorId))));
    const checkRuns = await allPages(opts.api, `/repos/${slug}/commits/${identity.headSha}/check-runs`, "check_runs");
    const priorCheck = checkRuns.find((item) => item.name === CHECK_NAME && ownedByPublisher(item));
    const payload = { name: CHECK_NAME, head_sha: identity.headSha, status: "completed", conclusion: check.conclusion, output: { title: `LessCode review: ${check.conclusion}`, summary: check.body } };
    await assertCurrent();
    const postedCheck = await opts.api.request(priorCheck
      ? { method: "PATCH", path: `/repos/${slug}/check-runs/${String(priorCheck.id)}`, body: payload }
      : { method: "POST", path: `/repos/${slug}/check-runs`, body: payload });
    const comments = await allPages(opts.api, `/repos/${slug}/issues/${opts.prNumber}/comments`);
    const priorComment = comments.find((item) => typeof item.body === "string" && item.body.startsWith(COMMENT_MARKER) && ownedByPublisher(item));
    await assertCurrent();
    const postedComment = await opts.api.request(priorComment
      ? { method: "PATCH", path: `/repos/${slug}/issues/comments/${String(priorComment.id)}`, body: { body: `${COMMENT_MARKER}\n${comment.body}` } }
      : { method: "POST", path: `/repos/${slug}/issues/${opts.prNumber}/comments`, body: { body: `${COMMENT_MARKER}\n${comment.body}` } });
    const outcome: GithubPrReviewOutcome = {
      check: { ...check, id: Number(asObj(postedCheck.body).id), action: priorCheck ? "updated" : "created" },
      comment: { ...comment, id: Number(asObj(postedComment.body).id), action: priorComment ? "updated" : "created" },
      patchOffer: { kind: offer, patch: result.applied }, prHeadSha: identity.headSha, verdict: result.verdict,
      ...(result.run ? { run: result.run } : {}),
    };
    if (!result.applied || offer === "none") return outcome;
    if (offer === "suggestions") {
      const suggestions = exactSuggestions(result.applied);
      if (suggestions.unsupportedReason) outcome.patchOffer.unsupportedReason = suggestions.unsupportedReason;
      else if (suggestions.comments.length) {
        await assertCurrent();
        await opts.api.request({ method: "POST", path: `/repos/${slug}/pulls/${opts.prNumber}/reviews`, body: { commit_id: identity.headSha, event: "COMMENT", comments: suggestions.comments } });
      }
      outcome.patchOffer.suggestions = suggestions.comments.length;
    } else outcome.patchOffer.branch = await offerBranch(change.checkout, identity, result.applied, opts.suggestionBranch, assertCurrent, opts.api, result.run?.artifact?.treeHash);
    return outcome;
  } finally { await loaded.dispose(); }
}
