import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubApi } from "../src/pr/github.js";
import { sourceGitEnvironment } from "../src/source/git.js";
import { deriveIntent, loadLocalChange, loadPullRequest } from "../src/source/index.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd })).stdout.trim();
}
function put(root: string, path: string, text: string): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
async function commit(root: string, message: string): Promise<string> {
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}
async function repository(opts: { docsOnly?: boolean; declaration?: unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lc-source-test-")); roots.push(root);
  const checkout = join(root, "checkout"), remote = join(root, "remote.git");
  mkdirSync(checkout);
  await git(checkout, "init", "-q", "-b", "main");
  put(checkout, "src/a.ts", "export const a = 1;\n");
  const commonSha = await commit(checkout, "common");
  await git(checkout, "branch", "feature");
  put(checkout, "src/main-only.ts", "export const main = 1;\n");
  const baseSha = await commit(checkout, "advance main");
  await git(checkout, "checkout", "-q", "feature");
  put(checkout, opts.docsOnly ? "README.md" : "src/a.ts", opts.docsOnly ? "Documentation only\n" : "export const a = 2;\n");
  if (opts.declaration) put(checkout, "lesscode-pr.json", JSON.stringify(opts.declaration));
  const headSha = await commit(checkout, "feature");
  await git(root, "init", "-q", "--bare", remote);
  await git(checkout, "push", "-q", remote, "main:refs/heads/main", "HEAD:refs/pull/7/head");
  const api: GithubApi = { async request() { return { status: 200, body: { head: { sha: headSha, ref: "feature", repo: { full_name: "fork/project" } }, base: { sha: baseSha, ref: "main" } } }; } };
  return { root, checkout, remote, commonSha, baseSha, headSha, api };
}

describe("immutable change source", () => {
  it("derives visible source scope without treating it as a declared intention", () => {
    expect(deriveIntent(["src/a.ts", "src/a.js", "src/App.svelte", "src/App.vue", "tests/a.test.ts", "lib/types.d.ts", ".github/workflows/ci.yml", "package.json", "tsconfig.json", "pnpm-workspace.yaml", "tests/__snapshots__/a.snap", "a.scss", "a.html", "README.md", "package-lock.json"]))
      .toEqual(["lib/types.d.ts", "src/App.svelte", "src/App.vue", "src/a.js", "src/a.ts", "tests/a.test.ts"]);
  });
  it("does not inherit process secrets or user Git execution configuration", () => {
    const previous = process.env.LESSCODE_TEST_TRANSPORT_SECRET;
    process.env.LESSCODE_TEST_TRANSPORT_SECRET = "test-only-secret";
    try {
      const env = sourceGitEnvironment({ NODE_OPTIONS: "test-loader", GIT_CONFIG_GLOBAL: "test-global-config", LESSCODE_TEST_TRANSPORT_SECRET: "test-only-secret" });
      expect(env.LESSCODE_TEST_TRANSPORT_SECRET).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
      expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null"); expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    } finally { if (previous === undefined) delete process.env.LESSCODE_TEST_TRANSPORT_SECRET; else process.env.LESSCODE_TEST_TRANSPORT_SECRET = previous; }
  });
  it("only accepts host-scoped HTTPS authorization configuration from Git authentication adapters", () => {
    const env = sourceGitEnvironment({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: "Authorization: Basic dGVzdA==" });
    expect(env.GIT_CONFIG_COUNT).toBe("1"); expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(() => sourceGitEnvironment({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "untrusted" })).toThrow(/HTTPS-host-scoped/);
  });
  it("excludes harness paths before checkout without opening harness files", async () => {
    const repo = await repository();
    // Construct harness metadata from an ordinary source blob; never create or read a harness file.
    const blob = await git(repo.checkout, "rev-parse", `${repo.headSha}:src/a.ts`);
    await git(repo.checkout, "update-index", "--add", "--cacheinfo", "100644", blob, "sealed/harness.ts");
    const tree = await git(repo.checkout, "write-tree");
    const head = await git(repo.checkout, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit-tree", tree, "-p", repo.headSha, "-m", "harness metadata");
    await git(repo.checkout, "push", "-q", repo.remote, `${head}:refs/pull/7/head`);
    const api: GithubApi = { async request() { return { status: 200, body: { head: { sha: head, ref: "feature" }, base: { sha: repo.baseSha, ref: "main" } } }; } };
    const loaded = await loadPullRequest({ api, owner: "base", repo: "project", number: 7, remoteUrl: repo.remote });
    try {
      expect(existsSync(join(loaded.change.checkout, "sealed"))).toBe(false);
      expect(readFileSync(join(loaded.change.checkout, ".git/info/sparse-checkout"), "utf8")).toContain("!**/sealed/");
      expect(loaded.change.changedFiles).toEqual(["src/a.ts"]);
    } finally { await loaded.dispose(); }
  });
  it("local source resolves refs once and does not own the caller checkout", async () => {
    const repo = await repository();
    const loaded = await loadLocalChange({ checkout: repo.checkout, base: repo.commonSha, intent: ["src/a.ts"] });
    expect(loaded.change).toMatchObject({ headSha: repo.headSha, baseSha: repo.commonSha, comparisonBaseSha: repo.commonSha, scope: { kind: "declared", paths: ["src/a.ts"] } });
    await loaded.dispose();
    expect(existsSync(repo.checkout)).toBe(true);
  });
  it("fetches fork PR refs from the base repository and compares from the merge base", async () => {
    const repo = await repository();
    const loaded = await loadPullRequest({ api: repo.api, owner: "base", repo: "project", number: 7, remoteUrl: repo.remote });
    const checkout = loaded.change.checkout;
    expect(loaded.change).toMatchObject({ headSha: repo.headSha, baseSha: repo.baseSha, comparisonBaseSha: repo.commonSha, changedFiles: ["src/a.ts"], intent: ["src/a.ts"], scope: { kind: "inferred" } });
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(repo.headSha);
    expect(existsSync(join(checkout, "src/main-only.ts"))).toBe(false);
    await loaded.dispose(); await loaded.dispose();
    expect(existsSync(checkout)).toBe(false);
    expect(await git(repo.checkout, "rev-parse", "HEAD")).toBe(repo.headSha);
  });
  it("accepts an optional declared scope only for the actual PR base", async () => {
    const repo = await repository({ declaration: { baseRef: "main", intent: ["src/a.ts"], relatedTests: ["tests/a.test.ts"] } });
    const loaded = await loadPullRequest({ api: repo.api, owner: "base", repo: "project", number: 7, remoteUrl: repo.remote });
    expect(loaded.change.scope.kind).toBe("declared");
    expect(loaded.change.relatedTests).toEqual(["tests/a.test.ts"]);
    await loaded.dispose();
  });
  it("rejects a declaration that selects an arbitrary base and removes the fetched checkout", async () => {
    const repo = await repository({ declaration: { baseRef: "other", intent: ["src/a.ts"] } });
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("lc-source-") && !name.startsWith("lc-source-test-")));
    await expect(loadPullRequest({ api: repo.api, owner: "base", repo: "project", number: 7, remoteUrl: repo.remote })).rejects.toThrow(/baseRef/);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("lc-source-") && !name.startsWith("lc-source-test-") && !before.has(name))).toEqual([]);
  });
  it("docs-only changes have empty inferred scope", async () => {
    const repo = await repository({ docsOnly: true });
    const loaded = await loadPullRequest({ api: repo.api, owner: "base", repo: "project", number: 7, remoteUrl: repo.remote });
    expect(loaded.change.intent).toEqual([]);
    expect(loaded.change.changedFiles).toEqual(["README.md"]);
    await loaded.dispose();
  });
  it("refuses a PR whose head changes while fetching", async () => {
    const repo = await repository();
    const api: GithubApi = { async request() { return { status: 200, body: { head: { sha: repo.commonSha, ref: "feature" }, base: { sha: repo.baseSha, ref: "main" } } }; } };
    await expect(loadPullRequest({ api, owner: "base", repo: "project", number: 7, remoteUrl: repo.remote })).rejects.toThrow(/head changed/);
  });
  it("rejects an unavailable immutable base before review", async () => {
    const repo = await repository();
    const api: GithubApi = { async request() { return { status: 200, body: { head: { sha: repo.headSha, ref: "feature" }, base: { sha: "0".repeat(40), ref: "main" } } }; } };
    await expect(loadPullRequest({ api, owner: "base", repo: "project", number: 7, remoteUrl: repo.remote })).rejects.toThrow();
  });
});
