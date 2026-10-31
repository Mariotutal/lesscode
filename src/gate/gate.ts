import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildSymbolGraph } from "./symbolGraph.js";
import { measureSource } from "./metrics.js";
import { isSourceFile } from "../classify/checkout.js";

const exec = promisify(execFile);

export interface GateCheck { name: string; passed: boolean; detail: string; }
export interface GateMetrics {
  sizeBefore: number; sizeAfter: number;
  cyclomaticBefore: number; cyclomaticAfter: number;
  changedFunctions: { file: string; name: string; before: number; after: number }[];
}
export interface GateResult {
  accepted: boolean;
  checks: GateCheck[];
  metrics: GateMetrics;
  exitCodes: { tests: number | null; tsc: number | null; eslint: number | null };
  /** Repo-derived commands actually run (tests/typecheck/lint), for audit. */
  commands?: { tests?: string; typecheck?: string; lint?: string };
}

/**
 * Discover the commands this repository actually uses, from
 * package.json. `test`: the repo's own script (never a hardcoded
 * runner). `typecheck`: its script, else tsc only when a tsconfig
 * exists (tsc without one prints help and exits 1 — not a failure).
 * `lint`: its script, normalized to an `npm run` invocation.
 */
export function repoCommands(repo: string): { test?: string; typecheck?: string; lint?: string } {
  try {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const s = pkg.scripts ?? {};
    const typecheckScript = s.typecheck ? "npm run typecheck" : s.tsc ? "npm run tsc" : undefined;
    return {
      test: s.test,
      typecheck: typecheckScript ?? (existsSync(join(repo, "tsconfig.json")) ? "npx tsc --noEmit" : undefined),
      lint: s.lint ? "npm run lint" : undefined,
    };
  } catch { return {}; }
}

export function isTestFilePath(f: string): boolean {
  return /(^|\/)tests?\//.test(f) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f) || f.includes("__tests__/")
    || /(^|\/)tests?\.[cm]?[jt]sx?$/.test(f);
}

/**
 * Test files in `tree` whose imports reach `file` (transitively).
 * Callers pass the PRE-edit tree: after an inline, the surviving test
 * no longer imports the deleted wrapper, so the after tree would
 * make every legitimate inline look uncovered.
 */
export function coveringTests(tree: Map<string, string>, file: string): string[] {
  const allFiles = [...tree.keys()];
  const resolve = (from: string, spec: string): string | undefined => {
    const parts: string[] = [];
    for (const seg of `${from.split("/").slice(0, -1).join("/")}/${spec}`.split("/")) {
      if (seg === "..") parts.pop(); else if (seg !== "." && seg !== "") parts.push(seg);
    }
    const stem = parts.join("/").replace(/\.[cm]?[jt]sx?$/, "");
    for (const cand of [parts.join("/"), ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].flatMap((e) => [`${stem}${e}`, `${stem}/index${e}`])]) if (allFiles.includes(cand)) return cand;
    return undefined;
  };
  const importsOf = new Map<string, string[]>();
  for (const f of allFiles) {
    const text = tree.get(f)!;
    importsOf.set(f, [...text.matchAll(/(?:from|import|require)\s*\(\s*["']([^"']+)["']|(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]!).filter((s) => s.startsWith(".")).map((s) => resolve(f, s)).filter((x): x is string => Boolean(x)));
  }
  const reaches = (start: string): boolean => {
    const seen = new Set<string>(); const stack = [start];
    while (stack.length) { const cur = stack.pop()!; if (cur === file) return true; if (seen.has(cur)) continue; seen.add(cur); stack.push(...(importsOf.get(cur) ?? [])); }
    return false;
  };
  return allFiles.filter((f) => isTestFilePath(f) && reaches(f));
}

export interface GateOptions {
  repoDir: string;
  baseRef: string;
  /** files the patch is allowed to change (edit set); exports elsewhere must stay identical */
  editSet: string[];
  /** explicit related test files/dirs to run, relative to repoDir */
  relatedTests: string[];
  /** Files exempt from the coverage check (code-mandated restore-from-base reverts to the PR base, not model edits). */
  coverageExempt?: string[];
  runCommands?: boolean; // default true
}

async function run(cmd: string, args: string[], cwd: string): Promise<number> {
  try { await exec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }); return 0; }
  catch (e) { const err = e as { code?: unknown }; return typeof err.code === "number" ? err.code : 1; }
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function treeAt(repo: string, ref: string): Promise<Map<string, string>> {
  const names = (await git(repo, ["ls-tree", "-r", "--name-only", ref])).split("\n").filter((f) => isSourceFile(f) && !f.includes("node_modules/"));
  const out = new Map<string, string>();
  for (const f of names) out.set(f, await git(repo, ["show", `${ref}:${f}`]));
  return out;
}

async function worktreeTree(repo: string, baseRef: string, baseFiles: Map<string, string>): Promise<Map<string, string>> {
  // patched tree = files changed vs base present in worktree + unchanged base files.
  // Diff against baseRef, not HEAD: a committed patch leaves `git diff HEAD` empty.
  const changed = (await git(repo, ["diff", "--name-only", baseRef])).split("\n").filter(Boolean);
  const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
  const out = new Map(baseFiles);
  for (const f of [...changed, ...untracked]) {
    if (f.includes("node_modules/")) continue;
    const abs = join(repo, f);
    if (!existsSync(abs)) out.delete(f);
    else if (isSourceFile(f)) out.set(f, readFileSync(abs, "utf8"));
  }
  return out;
}

function testDeletionCheck(diff: string): { passed: boolean; detail: string } {
  const removedTests: string[] = [];
  let skipAdded = false;
  let currentFile = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) currentFile = line.slice(6);
    const isTestFile = isTestFilePath(currentFile) || /(^|\/)sealed\//.test(currentFile);
    if (line.startsWith("-") && !line.startsWith("---") && isTestFile && /\b(it|test|describe)\s*\(/.test(line)) removedTests.push(currentFile);
    if (line.startsWith("+") && /\.(skip|todo)\s*\(|xit\s*\(|xdescribe\s*\(/.test(line)) skipAdded = true;
    if (line.startsWith("-") && !line.startsWith("---") && /deleted file/.test(line)) removedTests.push(currentFile);
  }
  // deleted test files show as `deleted file mode` in the header area; also caught via diff --name-status by caller
  if (skipAdded) return { passed: false, detail: "patch adds a skipped/todo test" };
  if (removedTests.length) return { passed: false, detail: `patch removes test cases in: ${[...new Set(removedTests)].join(", ")}` };
  return { passed: true, detail: "no test case removed or skipped" };
}

export async function evaluateGate(opts: GateOptions): Promise<GateResult> {
  const repo = opts.repoDir;
  const checks: GateCheck[] = [];
  const exitCodes: GateResult["exitCodes"] = { tests: null, tsc: null, eslint: null };

  // Diff the worktree against baseRef (not HEAD) so committed and uncommitted
  // candidate patches are judged identically.
  const diff = await git(repo, ["diff", opts.baseRef, "--", "."]);
  const nameStatus = await git(repo, ["diff", "--name-status", opts.baseRef]);
  const changedFiles = nameStatus.split("\n").filter(Boolean).map((l) => l.split("\t").at(-1)!);
  const touchedTs = changedFiles.filter((f) => isSourceFile(f) && existsSync(join(repo, f)));

  const beforeTree = await treeAt(repo, opts.baseRef);
  const afterTree = await worktreeTree(repo, opts.baseRef, beforeTree);

  // --- size (code lines only; comment-only hunks cannot win) ---
  const sumSize = (tree: Map<string, string>, files: string[]) =>
    files.reduce((a, f) => a + (tree.get(f) ? measureSource(f, tree.get(f)!).sizeLines : 0), 0);
  const allFiles = [...new Set([...beforeTree.keys(), ...afterTree.keys()])];
  const sizeBefore = sumSize(beforeTree, allFiles);
  const sizeAfter = sumSize(afterTree, allFiles);
  checks.push({ name: "size-drops", passed: sizeAfter < sizeBefore, detail: `code lines ${sizeBefore} -> ${sizeAfter} (comment/blank lines excluded)` });

  // --- cyclomatic on changed functions (matched by file+name, plus file totals for inlines) ---
  const changedFunctions: GateMetrics["changedFunctions"] = [];
  let cycBefore = 0, cycAfter = 0;
  for (const f of allFiles) {
    const b = beforeTree.get(f), a = afterTree.get(f);
    if (b === a) continue;
    const bm = b ? measureSource(f, b) : { cyclomaticSum: 0, functions: [] as never[] };
    const am = a ? measureSource(f, a) : { cyclomaticSum: 0, functions: [] as never[] };
    cycBefore += bm.cyclomaticSum; cycAfter += am.cyclomaticSum;
    const afterByName = new Map(am.functions.map((x) => [x.name, x.complexity]));
    for (const fn of bm.functions) changedFunctions.push({ file: f, name: fn.name, before: fn.complexity, after: afterByName.get(fn.name) ?? 0 });
    for (const fn of am.functions) if (!bm.functions.some((x) => x.name === fn.name)) changedFunctions.push({ file: f, name: fn.name, before: 0, after: fn.complexity });
  }
  // Per changed function (matched by name): a surviving function's complexity
  // may not rise >10%. Removed/inlined functions are handled by size+tests;
  // the god-function case is a surviving function absorbing their branches.
  let cycOk = true;
  const cycDetails: string[] = [];
  for (const cf of changedFunctions) {
    if (cf.after === 0) continue;
    const limit = cf.before === 0 ? 1 : cf.before * 1.1;
    if (cf.after > limit) { cycOk = false; cycDetails.push(`${cf.file}:${cf.name} ${cf.before} -> ${cf.after} exceeds +10%`); }
  }
  checks.push({ name: "cyclomatic-not-over-10pct", passed: cycOk, detail: cycDetails.join("; ") || `no changed function rises >10% (sum ${cycBefore} -> ${cycAfter})` });

  // --- exports outside edit set unchanged (symbol graph) ---
  const beforeGraph = buildSymbolGraph(beforeTree);
  const afterGraph = buildSymbolGraph(afterTree);
  const exportDiffs: string[] = [];
  for (const [file, syms] of beforeGraph) {
    if (opts.editSet.includes(file)) continue;
    const after = afterGraph.get(file);
    if (!after) { exportDiffs.push(`${file}: file removed outside edit set`); continue; }
    for (const [name, sig] of syms.exports) if (after.exports.get(name) !== sig) exportDiffs.push(`${file}: export ${name} changed/removed`);
    for (const name of after.exports.keys()) if (!syms.exports.has(name)) exportDiffs.push(`${file}: export ${name} added`);
  }
  for (const file of afterGraph.keys()) if (!beforeGraph.has(file) && !opts.editSet.includes(file)) exportDiffs.push(`${file}: new file outside edit set`);
  checks.push({ name: "exports-outside-edit-set-unchanged", passed: exportDiffs.length === 0, detail: exportDiffs.join("; ") || "exports outside edit set identical" });

  // --- tests not deleted/skipped ---
  const deletedTestFiles = nameStatus.split("\n").filter((l) => l.startsWith("D")).map((l) => l.split("\t")[1] ?? "").filter((f) => isTestFilePath(f));
  const td = testDeletionCheck(diff);
  checks.push({ name: "tests-not-deleted", passed: td.passed && deletedTestFiles.length === 0, detail: deletedTestFiles.length ? `deleted test files: ${deletedTestFiles.join(", ")}` : td.detail });

  // --- coverage: every edited non-test file must be imported (transitively)
  // by at least one named related test. A passing unrelated test + a size
  // drop must never accept an edit (zustand demo case). ---
  const commands = repoCommands(repo);
  const uncovered = opts.editSet.filter((f) => isSourceFile(f) && !isTestFilePath(f) && !(opts.coverageExempt ?? []).includes(f) && !coveringTests(beforeTree, f).some((t) => opts.relatedTests.some((r) => t === r || t.startsWith(r.endsWith("/") ? r : `${r}/`))));
  checks.push({ name: "edit-covered-by-related-tests", passed: uncovered.length === 0, detail: uncovered.length ? `no related test imports: ${uncovered.join(", ")}` : "every edited file is imported by a related test" });

  // --- commands: the repository's own, or reject. Exit codes are truth. ---
  const commandsRun: GateResult["commands"] = {};
  if (opts.runCommands !== false) {
    const shell = async (cmdline: string): Promise<number> => {
      try { await exec("bash", ["-c", cmdline], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }); return 0; }
      catch (e) { const err = e as { code?: unknown }; return typeof err.code === "number" ? err.code : 1; }
    };
    if (!commands.test) {
      checks.push({ name: "related-tests-pass", passed: false, detail: "repository has no test command (package.json scripts.test); cannot verify the edit" });
    } else if (/\bvitest\b/.test(commands.test)) {
      commandsRun.tests = `npx vitest run ${opts.relatedTests.join(" ")}`;
      exitCodes.tests = await run("npx", ["vitest", "run", ...opts.relatedTests], repo);
      checks.push({ name: "related-tests-pass", passed: exitCodes.tests === 0, detail: `${commandsRun.tests} exit ${exitCodes.tests}` });
    } else {
      // node:test / tap / mocha / jest / custom: run the repo script with
      // the related test paths appended (runners accept file args).
      commandsRun.tests = `${commands.test} ${opts.relatedTests.join(" ")}`.trim();
      exitCodes.tests = await shell(commandsRun.tests);
      checks.push({ name: "related-tests-pass", passed: exitCodes.tests === 0, detail: `${commandsRun.tests} exit ${exitCodes.tests}` });
    }
    if (commands.typecheck) {
      commandsRun.typecheck = commands.typecheck;
      exitCodes.tsc = await shell(commands.typecheck);
      checks.push({ name: "tsc-passes", passed: exitCodes.tsc === 0, detail: `${commandsRun.typecheck} exit ${exitCodes.tsc}` });
    } else {
      checks.push({ name: "tsc-passes", passed: true, detail: "no typecheck command and no tsconfig; skipped" });
    }
    const hasEslintConfig = ["eslint.config.mjs", "eslint.config.js", "eslint.config.cjs", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs"].some((f) => existsSync(join(repo, f)));
    if (touchedTs.length && (commands.lint || hasEslintConfig)) {
      commandsRun.lint = commands.lint ?? `npx eslint ${touchedTs.join(" ")}`;
      exitCodes.eslint = commands.lint
        ? await shell(`${commands.lint} -- ${touchedTs.join(" ")}`)
        : await run("npx", ["eslint", ...touchedTs], repo);
      checks.push({ name: "eslint-touched-passes", passed: exitCodes.eslint === 0, detail: `${commandsRun.lint} exit ${exitCodes.eslint} on ${touchedTs.join(", ")}` });
    } else if (touchedTs.length) {
      checks.push({ name: "eslint-touched-passes", passed: true, detail: "repository has no eslint config/command; skipped" });
    } else {
      checks.push({ name: "eslint-touched-passes", passed: true, detail: "no touched source files" });
    }
  }

  return { accepted: checks.every((c) => c.passed), checks, metrics: { sizeBefore, sizeAfter, cyclomaticBefore: cycBefore, cyclomaticAfter: cycAfter, changedFunctions }, exitCodes, commands: commandsRun };
}
