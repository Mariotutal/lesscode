import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
const exec = promisify(execFile);

/** Git transport never inherits model credentials, loader hooks, user Git configuration, or tracing. */
export function sourceGitEnvironment(authentication?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const credentials: NodeJS.ProcessEnv = {};
  const count = Number(authentication?.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > 16) throw new Error("invalid Git authentication configuration");
  for (let index = 0; index < count; index++) {
    const key = authentication?.[`GIT_CONFIG_KEY_${index}`];
    const value = authentication?.[`GIT_CONFIG_VALUE_${index}`];
    if (!key || !/^http\.https:\/\/[a-z\d.-]+(?::\d+)?\/\.extraheader$/i.test(key) || !value || /[\r\n]/.test(value) || !/^Authorization: (Basic|Bearer) /i.test(value)) throw new Error("Git credentials must be an HTTPS-host-scoped authorization header");
    credentials[`GIT_CONFIG_KEY_${index}`] = key;
    credentials[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  if (count) credentials.GIT_CONFIG_COUNT = String(count);
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: tmpdir(), LANG: "C", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_TRACE: "0", GIT_CURL_VERBOSE: "0", GIT_TRACE_CURL: "0",
    ...credentials,
  };
}

export async function sourceGit(cwd: string, args: string[], authentication?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", ...args], {
    cwd, timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
    env: sourceGitEnvironment(authentication),
  });
  return stdout.trimEnd();
}

/** Must run before checkout: harness-only paths remain Git objects and are never materialized. */
export async function excludeHarnessPaths(checkout: string): Promise<void> {
  const gitDir = (await sourceGit(checkout, ["rev-parse", "--absolute-git-dir"])).trim();
  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(join(gitDir, "info", "sparse-checkout"), "/*\n!**/sealed/\n");
  await sourceGit(checkout, ["config", "--local", "core.sparseCheckout", "true"]);
  await sourceGit(checkout, ["config", "--local", "core.sparseCheckoutCone", "false"]);
  await sourceGit(checkout, ["config", "--local", "index.sparse", "false"]);
}

export async function resolveCommit(checkout: string, ref: string): Promise<string> {
  return (await sourceGit(checkout, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
}

export async function diffPaths(checkout: string, base: string, head: string): Promise<string[]> {
  const text = await sourceGit(checkout, ["diff", "--name-only", "--no-ext-diff", "--no-textconv", "--no-renames", "-z", base, head, "--", ".", ":(exclude)**/sealed/**", ":(exclude)sealed/**"]);
  return text.split("\0").filter(Boolean).sort();
}
