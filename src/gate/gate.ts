import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
/** Command checks run on the untouched checkout (HEAD/base) before edits. */
export interface GateBaseline {
  exitCodes: { tests: number | null; tsc: number | null; eslint: number | null };
  /** Names of command checks that already failed before any edit. */
  preExistingFailures: string[];
}
export interface GateResult {
  accepted: boolean;
  checks: GateCheck[];
  metrics: GateMetrics;
  exitCodes: { tests: number | null; tsc: number | null; eslint: number | null };
  /** Baseline run on the untouched tree; absent when commands are off. */
  baseline?: GateBaseline;
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
  /**
   * Exported symbol each edited file's finding targets (only that symbol may
   * disappear/vanish from that file inside the edit set) — from code-verified
   * findings via findTarget, never the model. Plain names accepted as shorthand.
   */
  targetSymbols?: (string | { file: string; name: string })[];
  runCommands?: boolean; // default true
  /**
   * Precomputed baseline (e.g. simplify runs the gate per edit; the baseline
   * of the untouched checkout does not change between those runs). When
   * omitted and commands run, it is measured once on baseRef.
   */
  baseline?: GateBaseline;
}

const baselineCache = new Map<string, Promise<GateBaseline>>();

/** Drop cached baselines (tests / long-lived processes with moving refs). */
export function clearGateBaselineCache(): void { baselineCache.clear(); }

async function run(cmd: string, args: string[], cwd: string): Promise<number> {
  try { await exec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }); return 0; }
  catch (e) { const err = e as { code?: unknown }; return typeof err.code === "number" ? err.code : 1; }
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Run the repo's command checks once on the untouched base tree, in a scratch worktree. */
export async function measureBaseline(opts: Pick<GateOptions, "repoDir" | "baseRef" | "relatedTests">): Promise<GateBaseline> {
  const key = `${opts.repoDir}\0${opts.baseRef}\0${opts.relatedTests.join(",")}`;
  let pending = baselineCache.get(key);
  if (!pending) {
    pending = (async () => {
      const parent = mkdtempSync(join(tmpdir(), "lc-gate-baseline-"));
      const scratch = join(parent, "repo");
      try {
        const sha = (await git(opts.repoDir, ["rev-parse", opts.baseRef])).trim();
        await exec("git", ["worktree", "add", "--detach", scratch, sha], { cwd: opts.repoDir, maxBuffer: 64 * 1024 * 1024 });
        if (existsSync(join(opts.repoDir, "node_modules")) && !existsSync(join(scratch, "node_modules"))) {
          await exec("ln", ["-s", join(opts.repoDir, "node_modules"), join(scratch, "node_modules")]);
        }
        const commands = repoCommands(scratch);
        const ran = await runCommandChecks(scratch, opts.relatedTests, commands, (await git(scratch, ["diff", "--name-only", sha])).split("\n").filter(Boolean));
        return { exitCodes: ran.exitCodes, preExistingFailures: ran.checks.filter((c) => !c.passed).map((c) => c.name) };
      } finally {
        await exec("git", ["worktree", "remove", "--force", scratch], { cwd: opts.repoDir }).catch(() => undefined);
        await exec("git", ["worktree", "prune"], { cwd: opts.repoDir }).catch(() => undefined);
        rmSync(parent, { recursive: true, force: true });
      }
    })();
    baselineCache.set(key, pending);
    pending.catch(() => baselineCache.delete(key));
  }
  return pending;
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

/** The repo's own command checks (tests/typecheck/lint on touched). Shared by candidate and baseline runs. */
async function runCommandChecks(repo: string, relatedTests: string[], commands: ReturnType<typeof repoCommands>, touchedTs: string[]): Promise<{ checks: GateCheck[]; exitCodes: GateResult["exitCodes"]; commands: GateResult["commands"] }> {
  const checks: GateCheck[] = [];
  const exitCodes: GateResult["exitCodes"] = { tests: null, tsc: null, eslint: null };
  const commandsRun: GateResult["commands"] = {};
  const shell = async (cmdline: string): Promise<number> => {
    try { await exec("bash", ["-c", cmdline], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }); return 0; }
    catch (e) { const err = e as { code?: unknown }; return typeof err.code === "number" ? err.code : 1; }
  };
  if (!commands.test) {
    checks.push({ name: "related-tests-pass", passed: false, detail: "repository has no test command (package.json scripts.test); cannot verify the edit" });
  } else if (/\bvitest\b/.test(commands.test)) {
    commandsRun.tests = `npx vitest run ${relatedTests.join(" ")}`;
    exitCodes.tests = await run("npx", ["vitest", "run", ...relatedTests], repo);
    checks.push({ name: "related-tests-pass", passed: exitCodes.tests === 0, detail: `${commandsRun.tests} exit ${exitCodes.tests}` });
  } else {
    commandsRun.tests = `${commands.test} ${relatedTests.join(" ")}`.trim();
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
    exitCodes.eslint = commands.lint ? await shell(`${commands.lint} -- ${touchedTs.join(" ")}`) : await run("npx", ["eslint", ...touchedTs], repo);
    checks.push({ name: "eslint-touched-passes", passed: exitCodes.eslint === 0, detail: `${commandsRun.lint} exit ${exitCodes.eslint} on ${touchedTs.join(", ")}` });
  } else {
    checks.push({ name: "eslint-touched-passes", passed: true, detail: touchedTs.length ? "repository has no eslint config/command; skipped" : "no touched source files" });
  }
  return { checks, exitCodes, commands: commandsRun };
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

  // --- cyclomatic, matched by file+name+declaration kind+position ---
  // (name alone collides for same-named methods and anonymous functions).
  const changedFunctions: GateMetrics["changedFunctions"] = [];
  let cycBefore = 0, cycAfter = 0;
  for (const f of allFiles) {
    const b = beforeTree.get(f), a = afterTree.get(f);
    if (b === a) continue;
    const bm = b ? measureSource(f, b) : { cyclomaticSum: 0, functions: [] as never[] };
    const am = a ? measureSource(f, a) : { cyclomaticSum: 0, functions: [] as never[] };
    cycBefore += bm.cyclomaticSum; cycAfter += am.cyclomaticSum;
    const afterByKey = new Map(am.functions.map((x) => [x.key, x.complexity]));
    const beforeKeys = new Set(bm.functions.map((x) => x.key));
    for (const fn of bm.functions) changedFunctions.push({ file: f, name: fn.name, before: fn.complexity, after: afterByKey.get(fn.key) ?? 0 });
    for (const fn of am.functions) if (!beforeKeys.has(fn.key)) changedFunctions.push({ file: f, name: fn.name, before: 0, after: fn.complexity });
  }
  // A surviving function (before>=1) may rise by at most max(+10%, +1):
  // at complexity 1-2 the pure 10% cap forbids any rise at all.
  let cycOk = true;
  const cycDetails: string[] = [];
  for (const cf of changedFunctions) {
    if (cf.after === 0) continue;
    const limit = cf.before === 0 ? 1 : Math.max(cf.before * 1.1, cf.before + 1);
    if (cf.after > limit) { cycOk = false; cycDetails.push(`${cf.file}:${cf.name} ${cf.before} -> ${cf.after} exceeds cap ${limit}`); }
  }
  checks.push({ name: "cyclomatic-not-over-10pct", passed: cycOk, detail: cycDetails.join("; ") || `no changed function rises >10% (sum ${cycBefore} -> ${cycAfter})` });

  // --- exports: outside the edit set identical; inside it, only the
  // finding's targeted symbol may disappear (signature changes on a
  // surviving symbol are its internal rewrite). Other removed/changed
  // exports are reported by name; additions are allowed. ---
  const beforeGraph = buildSymbolGraph(beforeTree);
  const afterGraph = buildSymbolGraph(afterTree);
  const exportDiffs: string[] = [];
  const insideDiffs: string[] = [];
  const targets = new Map<string, Set<string>>();
  const addTarget = (file: string, name: string) => { const s = targets.get(file) ?? new Set<string>(); s.add(name); targets.set(file, s); };
  // The check is enforceable only when the caller supplies the code-verified
  // targeted symbol(s) (simplify/pipeline derive them from findings via
  // findTarget). Without them the gate cannot tell a targeted removal from
  // an untargeted one — e.g. fixture 5's file legitimately loses several
  // exports to one edit and must still be judged on complexity alone.
  const hasExplicitTargets = Boolean(opts.targetSymbols?.length);
  if (opts.targetSymbols) for (const t of opts.targetSymbols) {
    if (typeof t === "string") for (const f of opts.editSet) addTarget(f, t);
    else addTarget(t.file, t.name);
  }
  for (const [file, syms] of beforeGraph) {
    const inside = opts.editSet.includes(file);
    const diffs = inside ? insideDiffs : exportDiffs;
    const after = afterGraph.get(file);
    if (!after) {
      if (inside && !hasExplicitTargets) continue; // no verified target: cannot judge (see above)
      if (inside) {
        const untargeted = [...syms.exports.keys()].filter((n) => !targets.get(file)?.has(n));
        if (untargeted.length) diffs.push(`${file}: file removed inside edit set removes untargeted exports ${untargeted.join(", ")}`);
      } else diffs.push(`${file}: file removed outside edit set`);
      continue;
    }
    for (const [name, sig] of syms.exports) {
      if (after.exports.has(name)) {
        // Inside: signature change allowed (declaration text includes body).
        if (!inside && after.exports.get(name) !== sig) diffs.push(`${file}: export ${name} changed/removed`);
      } else if (!inside || (hasExplicitTargets && !(targets.get(file)?.has(name) ?? false))) {
        diffs.push(`${file}: export ${name} ${inside ? "removed" : "changed/removed"}` + (inside ? " (not the targeted symbol)" : ""));
      }
    }
    if (!inside) for (const name of after.exports.keys()) if (!syms.exports.has(name)) diffs.push(`${file}: export ${name} added`);
  }
  for (const file of afterGraph.keys()) if (!beforeGraph.has(file) && !opts.editSet.includes(file)) exportDiffs.push(`${file}: new file outside edit set`);
  checks.push({ name: "exports-outside-edit-set-unchanged", passed: exportDiffs.length === 0, detail: exportDiffs.join("; ") || "exports outside edit set identical" });
  checks.push({ name: "exports-inside-edit-set-targeted-only", passed: insideDiffs.length === 0, detail: insideDiffs.join("; ") || (hasExplicitTargets ? "no untargeted export removed inside the edit set" : "no code-verified target symbol supplied; in-set export removals not judged") });

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

  // --- commands: the repository's own, or reject. Exit codes are truth.
  // Baseline first: failures already present on the untouched tree are
  // repository state, not a rejection of this edit. ---
  let baseline: GateBaseline | undefined;
  const commandsRun: GateResult["commands"] = {};
  if (opts.runCommands !== false) {
    baseline = opts.baseline ?? await measureBaseline(opts).catch((): GateBaseline => ({ exitCodes: { tests: null, tsc: null, eslint: null }, preExistingFailures: [] }));
    const ran = await runCommandChecks(repo, opts.relatedTests, commands, touchedTs);
    Object.assign(exitCodes, ran.exitCodes);
    Object.assign(commandsRun, ran.commands);
    const preExisting = new Set(baseline.preExistingFailures);
    for (const c of ran.checks) {
      checks.push(!c.passed && preExisting.has(c.name)
        ? { name: c.name, passed: true, detail: `${c.detail}; pre-existing baseline failure on the untouched checkout — repository state, not caused by this edit` }
        : c);
    }
    // Unconditional repository-state report (not a pass/fail check).
    checks.push({
      name: "baseline-pre-existing-failures",
      passed: true,
      detail: baseline.preExistingFailures.length
        ? `untouched checkout already fails: ${baseline.preExistingFailures.join(", ")} (tests exit ${baseline.exitCodes.tests}, tsc exit ${baseline.exitCodes.tsc}, eslint exit ${baseline.exitCodes.eslint})`
        : "untouched checkout passes its command checks",
    });
  }

  return { accepted: checks.every((c) => c.passed), checks, metrics: { sizeBefore, sizeAfter, cyclomaticBefore: cycBefore, cyclomaticAfter: cycAfter, changedFunctions }, exitCodes, commands: commandsRun, ...(baseline ? { baseline } : {}) };
}
