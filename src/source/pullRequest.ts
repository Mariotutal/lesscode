import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GithubApi } from "../pr/github.js";
import { readPrDeclaration } from "../pr/pr.js";
import { PR_DECLARATION_FILE } from "../pr/schema.js";
import { deriveIntent, type LoadedChange, type PullRequestIdentity } from "./change.js";
import { diffPaths, excludeHarnessPaths, resolveCommit, sourceGit } from "./git.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" ? value as ObjectValue : {};
const validSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);

export function validatePullRequestTarget(owner: string, repo: string, number: number): void {
  if (![owner, repo].every((part) => /^[a-z\d_.-]+$/i.test(part) && part !== "." && part !== "..") || !Number.isSafeInteger(number) || number < 1) {
    throw new Error("invalid GitHub repository or pull request number");
  }
}

export async function readPullRequest(opts: { api: GithubApi; owner: string; repo: string; number: number; remoteUrl?: string }): Promise<PullRequestIdentity> {
  validatePullRequestTarget(opts.owner, opts.repo, opts.number);
  const response = await opts.api.request({ method: "GET", path: `/repos/${opts.owner}/${opts.repo}/pulls/${opts.number}` });
  const pr = object(response.body), head = object(pr.head), base = object(pr.base);
  if (!validSha(head.sha) || !validSha(base.sha) || typeof base.ref !== "string" || typeof head.ref !== "string") throw new Error("pull request has no valid immutable head/base identity");
  return {
    owner: opts.owner, repo: opts.repo, number: opts.number,
    headSha: head.sha, baseSha: base.sha, baseRef: base.ref, headRef: head.ref,
    remoteUrl: opts.remoteUrl ?? `https://github.com/${opts.owner}/${opts.repo}.git`,
  };
}

/** Fetches PR refs from the base repository, including fork PRs, without running repository code. */
export async function loadPullRequest(opts: {
  api: GithubApi;
  owner: string;
  repo: string;
  number: number;
  remoteUrl?: string;
  /** Captured identity lets a caller resolve exactly once before choosing an adapter. */
  identity?: PullRequestIdentity;
}): Promise<LoadedChange> {
  const identity = opts.identity ?? await readPullRequest(opts);
  const parent = mkdtempSync(join(tmpdir(), "lc-source-"));
  const checkout = join(parent, "repo");
  let disposed = false;
  const dispose = async () => { if (!disposed) { disposed = true; rmSync(parent, { recursive: true, force: true }); } };
  try {
    await sourceGit(parent, ["init", "-q", checkout]);
    await sourceGit(checkout, ["fetch", "--no-tags", "--", identity.remoteUrl, `refs/pull/${identity.number}/head`], opts.api.gitEnvironment?.());
    if (await resolveCommit(checkout, "FETCH_HEAD") !== identity.headSha) throw new Error("pull request head changed while fetching; retry the review");
    await sourceGit(checkout, ["fetch", "--no-tags", "--", identity.remoteUrl, identity.baseSha], opts.api.gitEnvironment?.());
    if (await resolveCommit(checkout, "FETCH_HEAD") !== identity.baseSha) throw new Error("fetched base does not match the pull request base SHA");
    await excludeHarnessPaths(checkout);
    await sourceGit(checkout, ["checkout", "-q", "--detach", identity.headSha]);
    const comparisonBaseSha = (await sourceGit(checkout, ["merge-base", identity.baseSha, identity.headSha])).trim();
    const changedFiles = await diffPaths(checkout, comparisonBaseSha, identity.headSha);
    let intent = deriveIntent(changedFiles);
    let scope: "declared" | "inferred" = "inferred";
    let relatedTests: string[] | undefined;
    const declarationPath = join(checkout, PR_DECLARATION_FILE);
    if (existsSync(declarationPath)) {
      if (!lstatSync(declarationPath).isFile()) throw new Error(`${PR_DECLARATION_FILE} must be a regular file`);
      const declaration = readPrDeclaration(checkout);
      if (declaration.baseRef !== identity.baseSha && declaration.baseRef !== identity.baseRef) throw new Error(`${PR_DECLARATION_FILE} baseRef does not match the pull request base`);
      intent = declaration.intent;
      scope = "declared";
      relatedTests = declaration.relatedTests;
    }
    return {
      change: { checkout, baseSha: identity.baseSha, headSha: identity.headSha, comparisonBaseSha, changedFiles, intent, scope: { kind: scope, paths: intent }, ...(relatedTests?.length ? { relatedTests } : {}) },
      pullRequest: identity, dispose,
    };
  } catch (error) { await dispose(); throw error; }
}
