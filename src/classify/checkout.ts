import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { isSealedPath, normaliseRepoPath } from "./evidence.js";

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
  return /(^|\/)tests?\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes("__tests__/")
    || /(^|\/)tests?\.[cm]?[jt]sx?$/.test(file);
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
/** Intent entries may name a file, a directory, or a glob (`*`, `**`, `?`). */
export function matchesIntent(file: string, intent: readonly string[]): boolean {
  return intent.some((entry) => {
    const e = entry.replace(/^\.\//, "").replace(/\/$/, "");
    if (!e) return false;
    if (!/[*?]/.test(e)) return file === e || file.startsWith(`${e}/`);
    const re = new RegExp(`^${e.split("**").map((part) => part.split("*").map((s) => s.split("?").map((q) => q.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".")).join("[^/]*")).join(".*")}$`);
    return re.test(file);
  });
}

export function expandIntentFiles(files: readonly string[], intent: readonly string[]): string[] {
  return files.filter((f) => matchesIntent(f, intent));
}

/** Paths that cannot change behaviour: exempt from scope-creep restoration by default. */
export function isNonBehaviourPath(file: string): boolean {
  const base = file.split("/").at(-1)!;
  if (/(^|\/)docs?\//.test(file) || /\.(md|mdx|rst|adoc)$/i.test(file) || /^(LICENSE|NOTICE|CHANGELOG)(\.|$)/i.test(base)) return true;
  return /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|Pipfile\.lock)$/.test(base);
}

/** Line numbers (new-file side) changed vs `baseRef`, per file, from `git diff -U0`. */
export async function changedLinesFromGit(checkoutDir: string, baseRef: string): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>();
  let diff = "";
  try { diff = await git(checkoutDir, ["diff", "-U0", "--no-color", baseRef]); } catch { return out; }
  let file: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) { file = line.slice(6); if (!out.has(file)) out.set(file, new Set()); continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && file) { const start = Number(m[1]); const count = m[2] === undefined ? 1 : Number(m[2]); for (let i = 0; i < count; i++) out.get(file)!.add(start + i); }
  }
  return out;
}

function isTypeOnlyImporterOf(checkoutDir: string, file: string, targets: Set<string>, allSet: Set<string>): boolean {
  let text: string;
  try { text = readFileSync(join(checkoutDir, file), "utf8"); } catch { return false; }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let saw = false;
  for (const node of sf.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.startsWith(".")) continue;
    const resolved = resolveSpecifier(file, node.moduleSpecifier.text, allSet);
    if (!resolved || !targets.has(resolved)) continue;
    saw = true;
    const clause = node.importClause;
    const typeOnly = !!clause && (clause.isTypeOnly || (!!clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every((e) => e.isTypeOnly) && !clause.name));
    if (!typeOnly) return false;
  }
  return saw;
}

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
  for (const f of expandIntentFiles(all, opts.intentFiles)) push(f, true);
  for (const f of opts.changedFiles ?? []) push(f, true);
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
  // A file that only imports a type from a seed is not part of the
  // review context/note; it remains visible to code (symbol graph /
  // verification over the whole checkout) for shared-symbol decisions.
  for (const f of all) for (const t of imports.get(f)!) if (seeds.has(t) && !isTypeOnlyImporterOf(checkoutDir, f, seeds, allSet)) push(f);
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
  for (const m of text.matchAll(/(?:from|import|require)\s*\(\s*["']([^"']+)["']|(?:from|import)\s+["']([^"']+)["']/g)) {
    const spec = m[1] ?? m[2]!;
    if (!spec.startsWith(".")) continue;
    const r = resolveSpecifier(file, spec, allSet);
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
  return (files ?? listClassifiableFiles(checkoutDir)).filter((file) => !isSealedPath(file) && normaliseRepoPath(checkoutDir, file) === file && isSourceFile(file)).map((file) => {
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
    const path = join(checkoutDir, "tsconfig.json");
    const read = ts.readConfigFile(path, ts.sys.readFile);
    if (read.error || !read.config) return { allowJs: false, checkJs: false };
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, checkoutDir);
    return { allowJs: parsed.options.allowJs === true, checkJs: parsed.options.checkJs === true };
  } catch {
    return { allowJs: false, checkJs: false };
  }
}

/** Non-empty changed-file list from git (names only; no content from sealed dirs). */
export async function changedFilesFromGit(checkoutDir: string, baseRef: string): Promise<string[]> {
  // Tracked changes only: an untracked local file is not part of the PR.
  const tracked = await git(checkoutDir, ["diff", "--name-only", "-z", baseRef, "--"]);
  const names = tracked.split("\0")
    .filter(Boolean)
    .filter((f) => !isSealedPath(f) && !f.includes("node_modules/"));
  return [...new Set(names)].sort();
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
