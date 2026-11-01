import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findConvention, loadRepositoryConventions } from "./conventions.js";
import { eslintRuleEnabled, eslintRuleForConvention, applyEslintFix, applyEslintFixAsync, eslintRuleEnabledAsync } from "./eslintFix.js";
import type { Finding } from "./schema.js";

import type { RepositoryExecutor } from "../execution/index.js";

export type ConventionDecision =
  | { status: "fixable"; finding: Finding; convention: string }
  | { status: "refused"; finding: Finding; reason: string };

/**
 * Apply-or-refuse for convention-break findings (closed set rule):
 * keep a finding only when a registered mechanical fix applies to at
 * least one cited line range. Otherwise refuse — never guess an edit.
 *
 * When the convention maps to an ESLint rule the repository config
 * already enables, the fix is applied by ESLint (see eslintFix.ts)
 * instead of a LessCode text rewrite, so "no rule enabled, no edit"
 * replaces the raw text rewrite for those conventions.
 */
export function decideConventionBreak(
  checkoutDir: string,
  findings: readonly Finding[],
  registeredInRepo: readonly string[] = loadRepositoryConventions(checkoutDir),
  executor?: RepositoryExecutor,
): ConventionDecision[] {
  const registered = new Set(registeredInRepo);
  return findings.map((finding) => {
    const name = finding.convention;
    if (!name) {
      return { status: "refused", finding, reason: "convention-break finding names no convention" };
    }
    const convention = findConvention(name, registered);
    const rule = eslintRuleForConvention(name);
    const hasTextRewrite = convention !== undefined && hasEffectiveTextRewrite(name);
    if (!convention || (!hasTextRewrite && !(rule && eslintRuleEnabled(checkoutDir, finding.file, rule, executor)))) {
      return {
        status: "refused",
        finding,
        reason: registered.has(name)
          ? rule && !hasTextRewrite
            ? `convention "${name}" is registered in the repository but ESLint rule "${rule}" is not enabled by the repository ESLint config, and no text rewrite may produce the edit`
            : `convention "${name}" is registered in the repository but has no mechanical fix`
          : `convention "${name}" is not written in this repository's convention registry (lesscode-conventions.json)`,
      };
    }
    if (!hasTextRewrite) {
      // ESLint-backed fix: fixable iff ESLint actually changes the file.
      const fixed = applyEslintFix(checkoutDir, finding.file, executor);
      return fixed !== undefined
        ? { status: "fixable", finding, convention: name }
        : {
            status: "refused",
            finding,
            reason: `ESLint fix for "${name}" does not change ${finding.file}`,
          };
    }
    let text: string;
    try {
      text = readFileSync(join(checkoutDir, finding.file), "utf8");
    } catch {
      return { status: "refused", finding, reason: `cannot read ${finding.file} in checkout` };
    }
    const lines = text.split("\n");
    const cited = finding.citations
      .filter((c) => c.file === finding.file)
      .flatMap((c) => lines.slice(c.startLine - 1, c.endLine));
    const segment = cited.join("\n");
    if (!segment || !convention.appliesTo(segment)) {
      return {
        status: "refused",
        finding,
        reason: `mechanical fix for "${name}" does not apply to the cited lines`,
      };
    }
    return { status: "fixable", finding, convention: name };
  });
}

/**
 * Conventions whose catalogue entry carries an effective text rewrite.
 * semicolons / single-quotes are catalogued with identity rewrites so
 * they can be named, but no raw text rewrite may produce their edits.
 */
const TEXT_REWRITE_CONVENTIONS = new Set(["no-console-log", "import-extension-js", "no-trailing-whitespace"]);

function hasEffectiveTextRewrite(name: string): boolean {
  return TEXT_REWRITE_CONVENTIONS.has(name);
}

/**
 * Apply the registered mechanical fix to the cited ranges of a kept
 * convention-break finding. Callers write the file and let the gate
 * judge the result. Returns the new file contents, or undefined when
 * nothing changes (caller must then refuse).
 *
 * This function checks the repository registry itself
 * (lesscode-conventions.json): a practice the repository has not
 * written down is never applied, no matter who the caller is.
 *
 * When the convention maps to an ESLint rule the repository ESLint
 * configuration already enables, the fix is produced by running
 * ESLint fix on the touched file (in the scratch worktree the caller
 * points at) instead of a LessCode text rewrite. A raw text rewrite
 * of quotes or semicolons never produces an edit.
 */
export function applyConventionFix(checkoutDir: string, finding: Finding, executor?: RepositoryExecutor): string | undefined {
  const registered = new Set(loadRepositoryConventions(checkoutDir));
  const convention = finding.convention ? findConvention(finding.convention, registered) : undefined;
  if (!convention) return undefined;
  const name = finding.convention!;

  const rule = eslintRuleForConvention(name);
  if (rule && eslintRuleEnabled(checkoutDir, finding.file, rule, executor)) {
    return applyEslintFix(checkoutDir, finding.file, executor);
  }
  if (!hasEffectiveTextRewrite(name)) {
    // No text rewrite exists for this convention (semicolons /
    // single-quotes without the ESLint rule enabled): refuse rather
    // than fall back to a raw text rewrite.
    return undefined;
  }
  return applyTextConventionFix(checkoutDir, finding);
}

function applyTextConventionFix(checkoutDir: string, finding: Finding): string | undefined {
  const convention = findConvention(finding.convention ?? "", new Set(loadRepositoryConventions(checkoutDir)));
  if (!convention) return undefined;
  const lines = readFileSync(join(checkoutDir, finding.file), "utf8").split("\n");
  let changed = false;
  for (const c of finding.citations) {
    if (c.file !== finding.file) continue;
    for (let i = c.startLine - 1; i < c.endLine && i < lines.length; i++) {
      const fixed = convention.fix(lines[i]!);
      if (fixed !== lines[i]) {
        lines[i] = fixed;
        changed = true;
      }
    }
  }
  return changed ? lines.join("\n") : undefined;
}


export async function decideConventionBreakAsync(checkoutDir: string, findings: readonly Finding[], registeredInRepo: readonly string[] = loadRepositoryConventions(checkoutDir), executor?: RepositoryExecutor): Promise<ConventionDecision[]> {
  const decisions: ConventionDecision[] = [];
  for (const finding of findings) {
    const name = finding.convention;
    if (!name || !registeredInRepo.includes(name) || hasEffectiveTextRewrite(name)) {
      decisions.push(...decideConventionBreak(checkoutDir, [finding], registeredInRepo, executor));
      continue;
    }
    const rule = eslintRuleForConvention(name);
    if (!rule || !await eslintRuleEnabledAsync(checkoutDir, finding.file, rule, executor)) {
      decisions.push({ status: "refused", finding, reason: `convention "${name}" is registered but its ESLint rule is not enabled or available` });
      continue;
    }
    const fixed = await applyEslintFixAsync(checkoutDir, finding.file, executor);
    decisions.push(fixed === undefined ? { status: "refused", finding, reason: `ESLint fix for "${name}" does not change ${finding.file}` } : { status: "fixable", finding, convention: name });
  }
  return decisions;
}

export async function applyConventionFixAsync(checkoutDir: string, finding: Finding, executor?: RepositoryExecutor): Promise<string | undefined> {
  const name = finding.convention;
  if (!name || !findConvention(name, new Set(loadRepositoryConventions(checkoutDir)))) return undefined;
  const rule = eslintRuleForConvention(name);
  if (rule && await eslintRuleEnabledAsync(checkoutDir, finding.file, rule, executor)) return applyEslintFixAsync(checkoutDir, finding.file, executor);
  return hasEffectiveTextRewrite(name) ? applyTextConventionFix(checkoutDir, finding) : undefined;
}
