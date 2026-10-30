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

const JS_FILE_RE = /\.[cm]?jsx?$/;

export function isTestFile(file: string): boolean {
  return /(^|\/)tests?\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes("__tests__/");
}

/**
 * Files a review of a *change* may see: the intent files plus the
 * files the PR actually changed, their one-hop relative imports and
 * importers (the code needed to judge them), and related tests.
 * Everything else in the checkout is invisible to the models.
 * Priority order is preserved (intent/changed first, importers last)
 * so a budget-trimmed caller can drop the least relevant tail.
 * JavaScript neighbours are included only when the repo allows them
 * (allowJs); the intent/changed files themselves are always visible,
 * and TypeScript is always eligible. Sealed paths are never included.
 */
export function scopedReviewFiles(
  checkoutDir: string,
  opts: { intentFiles: readonly string[]; changedFiles?: readonly string[]; relatedTests?: readonly string[] },
): string[] {
  const { allowJs } = readTsConfig(checkoutDir);
  const eligible = (f: string): boolean =>
    isSourceFile(f) && !isSealedPath(f) && existsSync(join(checkoutDir, f));
  const all = listClassifiableFiles(checkoutDir).filter(eligible);
  const allSet = new Set(all);
  // allowJs=false keeps JavaScript out of the context, except the
  // change itself: the intent/changed files are always visible,
  // or a JavaScript change would have nothing to review.
  const jsAllowed = (f: string): boolean => allowJs || !JS_FILE_RE.test(f);
  const seeds = new Set<string>();
  const ordered: string[] = [];
  const push = (f: string, force = false): void => {
    if (!seeds.has(f) && allSet.has(f) && (force || jsAllowed(f))) { seeds.add(f); ordered.push(f); }
  };
  for (const f of [...opts.intentFiles, ...(opts.changedFiles ?? [])]) push(f, true);
  // Related tests explicitly named, else tests that import a seed.
  const tests = (opts.relatedTests ?? []).flatMap((t) =>
    all.filter((f) => f === t || f.startsWith(t.endsWith("/") ? t : `${t}/`)),
  );
  for (const t of tests) push(t);
  if (!opts.relatedTests?.length) {
    for (const f of all) if (isTestFile(f) && importsAny(checkoutDir, f, seeds)) push(f);
  }
  // One hop: what the seeds import, and what imports the seeds.
  const imports = new Map<string, Set<string>>();
  for (const f of all) imports.set(f, relativeImportsOf(checkoutDir, f, allSet));
  for (const f of all) for (const t of imports.get(f)!) if (seeds.has(t)) push(f);
  for (const f of [...seeds]) for (const t of imports.get(f) ?? []) push(t);
  return ordered;
}

function resolveSpecifier(fromFile: string, spec: string, allSet: Set<string>): string | undefined {
  const parts: string[] = [];
  for (const seg of `${fromFile.split("/").slice(0, -1).join("/")}/${spec}`.split("/")) {
    if (seg === "..") parts.pop(); else if (seg !== "." && seg !== "") parts.push(seg);
  }
  const stem = parts.join("/").replace(/\.[cm]?[jt]sx?$/, "");
  for (const cand of [parts.join("/"), ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].flatMap((e) => [`${stem}${e}`, `${stem}/index${e}`])]) {
    if (allSet.has(cand)) return cand;
  }
  return undefined;
}

function relativeImportsOf(checkoutDir: string, file: string, allSet: Set<string>): Set<string> {
  const out = new Set<string>();
  const text = readFileSync(join(checkoutDir, file), "utf8");
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    if (!m[1]!.startsWith(".")) continue;
    const r = resolveSpecifier(file, m[1]!, allSet);
    if (r) out.add(r);
  }
  return out;
}

function importsAny(checkoutDir: string, file: string, targets: Set<string>): boolean {
  for (const t of relativeImportsOf(checkoutDir, file, new Set(listClassifiableFiles(checkoutDir)))) if (targets.has(t)) return true;
  return false;
}

/** Rough token estimate (~1 token / 4 chars) for the window check. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Model context window (tokens) for the Muse models. Env-overridable for tests/other models. */
export function contextWindow(model: string): number {
  void model;
  const fromEnv = Number(process.env.LESSCODE_CONTEXT_WINDOW);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 1_048_576;
}

/**
 * Fail before the request when the prompt cannot fit the window.
 * The error names the estimated size and the window.
 */
export function assertFitsWindow(label: string, model: string, promptChars: number): void {
  const tokens = Math.ceil(promptChars / 4);
  const window = contextWindow(model);
  if (tokens > window) {
    throw new Error(`${label} prompt is ~${tokens} tokens, which exceeds the ${window}-token context window of ${model}; refusing to send`);
  }
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
