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
}

export interface GateOptions {
  repoDir: string;
  baseRef: string;
  /** files the patch is allowed to change (edit set); exports elsewhere must stay identical */
  editSet: string[];
  /** explicit related test files/dirs to run, relative to repoDir */
  relatedTests: string[];
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
    const isTestFile = /(^|\/)(tests?|sealed)\//.test(currentFile) || /\.test\.ts$/.test(currentFile);
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
  const deletedTestFiles = nameStatus.split("\n").filter((l) => l.startsWith("D")).map((l) => l.split("\t")[1] ?? "").filter((f) => /\.test\.ts$/.test(f) || /(^|\/)tests?\//.test(f));
  const td = testDeletionCheck(diff);
  checks.push({ name: "tests-not-deleted", passed: td.passed && deletedTestFiles.length === 0, detail: deletedTestFiles.length ? `deleted test files: ${deletedTestFiles.join(", ")}` : td.detail });

  // --- commands: exit codes are the source of truth ---
  if (opts.runCommands !== false) {
    exitCodes.tests = await run("npx", ["vitest", "run", ...opts.relatedTests], repo);
    checks.push({ name: "related-tests-pass", passed: exitCodes.tests === 0, detail: `vitest exit ${exitCodes.tests}` });
    exitCodes.tsc = await run("npx", ["tsc", "--noEmit"], repo);
    checks.push({ name: "tsc-passes", passed: exitCodes.tsc === 0, detail: `tsc --noEmit exit ${exitCodes.tsc}` });
    if (touchedTs.length) {
      exitCodes.eslint = await run("npx", ["eslint", ...touchedTs], repo);
      checks.push({ name: "eslint-touched-passes", passed: exitCodes.eslint === 0, detail: `eslint exit ${exitCodes.eslint} on ${touchedTs.join(", ")}` });
    } else {
      checks.push({ name: "eslint-touched-passes", passed: true, detail: "no touched .ts files" });
    }
  }

  return { accepted: checks.every((c) => c.passed), checks, metrics: { sizeBefore, sizeAfter, cyclomaticBefore: cycBefore, cyclomaticAfter: cycAfter, changedFunctions }, exitCodes };
}
