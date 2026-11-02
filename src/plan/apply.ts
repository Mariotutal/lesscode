import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GuestClient } from "../provider/types.js";
import { applyConventionFixAsync } from "../classify/conventionBreak.js";
import { loadRepositoryConventions } from "../classify/conventions.js";
import { isSealedPath, normaliseRepoPath } from "../classify/evidence.js";
import { findTarget } from "../classify/target.js";
import { trustedLocalExecutor, type RepositoryExecutor } from "../execution/index.js";
import { readGitFile } from "../engine/workspace.js";
import { transactEdit, type PreparedEdit } from "../engine/transaction.js";
import type { PlannedEdit } from "./schema.js";
import { WONDER_MODEL, type AnyFinding } from "./plan.js";
import { inlineCodemod, inlineSafetyReason, loadSources, retargetCodemod, retargetSafetyReason, type CodemodResult } from "./codemod.js";
import { statementDiffKeys, unrelatedChangeReason } from "./guard.js";

export interface AppliedEdit { findingIndex: number; action: PlannedEdit["action"]; files: string[]; repaired: boolean }
export interface SkippedEdit { findingIndex: number; reason: string }
export interface ApplyResult { applied: AppliedEdit[]; skipped: SkippedEdit[]; editSet: string[]; repairCalls: number }
export type Preparation = { status: "prepared"; edit: PreparedEdit } | { status: "unsupported"; reason: string };

/** Compute the complete write set before the transaction opens. No model-written bytes are applied. */
export async function prepareEdit(opts: { checkoutDir: string; baseRef: string; finding: AnyFinding; edit: PlannedEdit; executor?: RepositoryExecutor }): Promise<Preparation> {
  const { checkoutDir: repo, finding, edit } = opts;
  const file = normaliseRepoPath(repo, finding.file);
  if (!file || isSealedPath(file)) return { status: "unsupported", reason: "finding names an invalid source path" };
  let result: CodemodResult;
  if (edit.action === "restore-from-base" && finding.category === "scope-creep") {
    const text = await readGitFile(repo, opts.baseRef, file);
    result = text === null ? { newFiles: [], deleteFiles: [file] } : { newFiles: [{ file, content: text }], deleteFiles: [] };
  } else if (edit.action === "convention-fix" && finding.category === "convention-break") {
    if (!finding.convention || !loadRepositoryConventions(repo).includes(finding.convention)) return { status: "unsupported", reason: "convention is not in the repository registry" };
    const text = await applyConventionFixAsync(repo, finding, opts.executor);
    if (text === undefined) return { status: "unsupported", reason: "registered mechanical convention fix changed nothing" };
    result = { newFiles: [{ file, content: text }], deleteFiles: [] };
  } else if ((edit.action === "inline" && finding.category === "single-use-abstraction") || (edit.action === "retarget" && finding.category === "duplicate-helper")) {
    const sources = loadSources(repo);
    const entry = sources.get(file);
    const target = entry && findTarget(entry.sf, file, finding);
    if (!target) return { status: "unsupported", reason: "codemod: no declaration overlaps the finding citations" };
    const helper = finding.category === "duplicate-helper" && finding.existingHelperFile ? normaliseRepoPath(repo, finding.existingHelperFile) : undefined;
    const safetyReason = edit.action === "inline" ? inlineSafetyReason(target, file, sources) : helper ? retargetSafetyReason({ name: target.name, file }, helper, sources) : "missing existing helper";
    if (safetyReason) return { status: "unsupported", reason: `codemod: ${safetyReason}` };
    const generated = edit.action === "inline" ? inlineCodemod(target, file, sources)
      : helper && !isSealedPath(helper) ? retargetCodemod({ name: target.name, file }, helper, sources) : undefined;
    if (!generated) return { status: "unsupported", reason: `codemod: ${edit.action} of ${target.name} cannot be expressed safely as a mechanical edit` };
    const generatedFiles = new Map(generated.newFiles.map((f) => [f.file, f.content]));
    for (const supplied of edit.newFiles) {
      const generatedText = generatedFiles.get(supplied.file);
      if (generatedText === undefined) return { status: "unsupported", reason: `unrelated-change guard: model supplied contents for ${supplied.file}, outside the generated edit` };
      const before = sources.get(supplied.file)?.text;
      const reason = before === undefined ? undefined : unrelatedChangeReason(supplied.file, before, supplied.content, target.name, statementDiffKeys(before, generatedText, supplied.file));
      if (reason) return { status: "unsupported", reason: `unrelated-change guard: ${reason}` };
    }
    result = generated;
  } else return { status: "unsupported", reason: `${edit.action} does not match finding category ${finding.category}` };
  const after = new Map(result.newFiles.map((f) => [f.file, f.content as string | null]));
  for (const path of result.deleteFiles) {
    if (after.has(path)) return { status: "unsupported", reason: `edit both writes and deletes ${path}` };
    after.set(path, null);
  }
  return { status: "prepared", edit: { findingIndex: edit.findingIndex, changes: [...after].map(([path, text]) => ({ path, before: existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf8") : null, after: text })) } };
}

/** Compatibility adapter. Product runs use prepareEdit + the engine's transaction/gate. */
export async function applyPlan(opts: { checkoutDir: string; baseRef: string; findings: readonly AnyFinding[]; edits: readonly PlannedEdit[]; client?: GuestClient; runTsc?: (repo: string) => Promise<string | null>; executor?: RepositoryExecutor }): Promise<ApplyResult> {
  const applied: AppliedEdit[] = [], skipped: SkippedEdit[] = [];
  const executor = opts.executor ?? trustedLocalExecutor;
  for (const edit of opts.edits) {
    const finding = opts.findings[edit.findingIndex];
    if (!finding) { skipped.push({ findingIndex: edit.findingIndex, reason: "unknown finding" }); continue; }
    const prepared = await prepareEdit({ ...opts, finding, edit });
    if (prepared.status === "unsupported") { skipped.push({ findingIndex: edit.findingIndex, reason: prepared.reason }); continue; }
    const checked = await transactEdit(opts.checkoutDir, prepared.edit, async () => {
      let error: string | null = null;
      if (opts.runTsc) error = await opts.runTsc(opts.checkoutDir);
      else if (existsSync(join(opts.checkoutDir, "tsconfig.json"))) {
        const r = await executor.run({ repoDir: opts.checkoutDir, command: "./node_modules/.bin/tsc", args: ["--noEmit"] });
        if (r.exitCode !== 0) error = r.stderr || r.stdout || "typecheck failed";
      }
      return { keep: !error, result: error };
    });
    if (!checked.keep) skipped.push({ findingIndex: edit.findingIndex, reason: `codemod broke tsc, finding skipped (no repair turn): ${checked.result}` });
    else applied.push({ findingIndex: edit.findingIndex, action: edit.action, files: prepared.edit.changes.map((c) => c.path), repaired: false });
  }
  return { applied, skipped, editSet: [...new Set(applied.flatMap((a) => a.files))], repairCalls: 0 };
}
export { WONDER_MODEL };
