import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { isSealedPath } from "./evidence.js";

const exec = promisify(execFile);

export interface CheckoutSource {
  file: string;
  text: string;
  lines: string[];
}

export const SOURCE_FILE_RE = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/;

export function isSourceFile(file: string): boolean {
  return SOURCE_FILE_RE.test(file) && !file.endsWith(".d.ts");
}

/**
 * Files eligible for classification: every `.ts` file in the checkout,
 * excluding node_modules, dot-dirs, and — hard rule — any
 * fixtures/<n>/sealed/ tree. Sealed files are never listed, read, or
 * sent to the model.
 */
export function listClassifiableFiles(checkoutDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      const rel = relative(checkoutDir, abs).split(sep).join("/");
      if (isSealedPath(rel)) continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && isSourceFile(entry.name)) out.push(rel);
    }
  };
  walk(checkoutDir);
  return out.sort();
}

export function readCheckoutSources(checkoutDir: string, files?: string[]): CheckoutSource[] {
  return (files ?? listClassifiableFiles(checkoutDir)).map((file) => {
    const text = readFileSync(join(checkoutDir, file), "utf8");
    return { file, text, lines: text.split("\n") };
  });
}

export interface CheckoutTsConfig {
  allowJs: boolean;
  checkJs: boolean;
}

/**
 * The repository's own tsconfig settings that govern JavaScript.
 * `checkJs` is reported exactly as the repository set it — code never
 * turns it on for a repository that did not ask. (The gate's tsc step
 * runs the repository tsconfig, so this is also what tsc enforces.)
 */
export function readTsConfig(checkoutDir: string): CheckoutTsConfig {
  try {
    const parsed = JSON.parse(readFileSync(join(checkoutDir, "tsconfig.json"), "utf8")) as {
      compilerOptions?: { allowJs?: unknown; checkJs?: unknown };
    };
    return {
      allowJs: parsed.compilerOptions?.allowJs === true,
      checkJs: parsed.compilerOptions?.checkJs === true,
    };
  } catch {
    return { allowJs: false, checkJs: false };
  }
}

/** Non-empty changed-file list from git (names only; no content from sealed dirs). */
export async function changedFilesFromGit(checkoutDir: string, baseRef: string): Promise<string[]> {
  const tracked = await git(checkoutDir, ["diff", "--name-only", baseRef]);
  const untracked = await git(checkoutDir, ["ls-files", "--others", "--exclude-standard"]);
  const names = [...tracked.split("\n"), ...untracked.split("\n")]
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => !isSealedPath(f) && !f.includes("node_modules/"));
  return [...new Set(names)].sort();
}

/** Read every file present at `ref` in git (for base-tree comparison). */
export async function treeAtRef(checkoutDir: string, ref: string): Promise<Map<string, string>> {
  const names = (await git(checkoutDir, ["ls-tree", "-r", "--name-only", ref]))
    .split("\n")
    .filter((f) => isSourceFile(f) && !f.includes("node_modules/") && !isSealedPath(f));
  const out = new Map<string, string>();
  for (const f of names) out.set(f, await git(checkoutDir, ["show", `${ref}:${f}`]));
  return out;
}

export async function worktreeExists(checkoutDir: string, file: string): Promise<boolean> {
  return existsSync(join(checkoutDir, file));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
