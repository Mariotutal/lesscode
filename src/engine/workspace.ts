import { execFile } from "node:child_process";
import { constants, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export async function git(repo: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd: repo, timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

export async function readGitFile(repo: string, ref: string, file: string): Promise<string | null> {
  try { return await git(repo, ["show", `${ref}:${file}`]); } catch { return null; }
}

/** Private clone: no shared writable Git metadata or dependency directory. */
export async function openWorkspace(checkout: string, expectedHead: string | undefined, copyDependencies: boolean) {
  const source = resolve(checkout);
  const headSha = (await git(source, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).trim();
  if (expectedHead && expectedHead !== headSha) throw new Error("checkout HEAD does not match the requested review revision");
  const parent = mkdtempSync(join(tmpdir(), "lc-run-"));
  const repo = join(parent, "repo");
  try {
    await exec("git", ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-hardlinks", "--no-checkout", "--", source, repo], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    await git(repo, ["config", "core.hooksPath", "/dev/null"]);
    await git(repo, ["sparse-checkout", "set", "--no-cone", "/*", "!**/sealed/", "!/node_modules/"]);
    await git(repo, ["checkout", "--quiet", "--detach", headSha]);
    // Keep generated dependencies out of the patch even for repositories without a .gitignore.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(repo, ".git", "info", "exclude"), "\n/node_modules/\n");
    if (copyDependencies && existsSync(join(source, "node_modules"))) {
      cpSync(realpathSync(join(source, "node_modules")), join(repo, "node_modules"), { recursive: true, mode: constants.COPYFILE_FICLONE, dereference: false });
    }
    return { repo, headSha, dispose: () => rmSync(parent, { recursive: true, force: true }) };
  } catch (error) { rmSync(parent, { recursive: true, force: true }); throw error; }
}

/** Actual patch paths, including untracked files; filenames are never shell parsed. */
export async function changedPaths(repo: string, headSha: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(repo, ["diff", "--name-only", "-z", headSha, "--"]),
    git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))].sort();
}

export function fileText(repo: string, path: string): string | null {
  return existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf8") : null;
}
