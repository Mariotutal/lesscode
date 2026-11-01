import { isNonBehaviourPath, matchesIntent } from "./checkout.js";
import type { Citation, Finding } from "./schema.js";

/**
 * Scope creep is decided by code, not by the model (LES-3).
 *
 * Given the files changed vs a base ref and the changed files that
 * belong to the declared PR intent, every other changed file is scope
 * creep — restore it from the base. The model is never consulted for
 * this category and reports no creep itself.
 *
 * Line citations point at the first line of the file. The keep/drop
 * rule lives in classifyFindings (LES-29): a file present in the
 * checkout is kept outright; a deleted file is kept only when line 1
 * checks out against the base-ref copy the caller supplies.
 */
export interface ScopeCreepFinding extends Omit<Finding, "category"> {
  category: "scope-creep";
  /** Code-decided action: restore this file from the base ref. */
  action: "restore-from-base";
}

export interface ScopeCreepInput {
  /** Files changed vs the base ref (repo-relative). */
  changedFiles: readonly string[];
  /** Files that belong to the PR's declared intent (repo-relative). */
  intentFiles: readonly string[];
  /** Evidence lines per changed file (default: line 1). */
  lineCount?: (file: string) => number;
}

/** Changed paths kept (not restored) because they cannot change behaviour, with why. */
export function exemptScopeCreep(input: ScopeCreepInput): { file: string; reason: string }[] {
  return [...input.changedFiles].sort().filter((f) => !matchesIntent(f, input.intentFiles) && isNonBehaviourPath(f))
    .map((file) => ({ file, reason: `${file} is outside the PR intent but kept: documentation/lockfile paths cannot change behaviour, so it is exempt from restoration` }));
}

export function decideScopeCreep(input: ScopeCreepInput): ScopeCreepFinding[] {
  const out: ScopeCreepFinding[] = [];
  for (const file of [...input.changedFiles].sort()) {
    if (matchesIntent(file, input.intentFiles) || isNonBehaviourPath(file)) continue;
    const citation: Citation = {
      file,
      startLine: 1,
      endLine: 1,
    };
    out.push({
      category: "scope-creep",
      file,
      citations: [citation],
      action: "restore-from-base",
      rationale:
        `Changed vs base but not part of the PR intent (${input.intentFiles.join(", ") || "none declared"}); ` +
        "restore from base.",
    });
  }
  return out;
}
