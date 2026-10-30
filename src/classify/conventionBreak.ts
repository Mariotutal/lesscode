import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findConvention, loadRepositoryConventions } from "./conventions.js";
import type { Finding } from "./schema.js";

export type ConventionDecision =
  | { status: "fixable"; finding: Finding; convention: string }
  | { status: "refused"; finding: Finding; reason: string };

/**
 * Apply-or-refuse for convention-break findings (closed set rule):
 * keep a finding only when a registered mechanical fix applies to at
 * least one cited line range. Otherwise refuse — never guess an edit.
 */
export function decideConventionBreak(
  checkoutDir: string,
  findings: readonly Finding[],
  registeredInRepo: readonly string[] = loadRepositoryConventions(checkoutDir),
): ConventionDecision[] {
  const registered = new Set(registeredInRepo);
  return findings.map((finding) => {
    const name = finding.convention;
    if (!name) {
      return { status: "refused", finding, reason: "convention-break finding names no convention" };
    }
    const convention = findConvention(name, registered);
    if (!convention) {
      return {
        status: "refused",
        finding,
        reason: registered.has(name)
          ? `convention "${name}" is registered in the repository but has no mechanical fix`
          : `convention "${name}" is not written in this repository's convention registry (lesscode-conventions.json)` ,
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
 * Apply the registered mechanical fix to the cited ranges of a kept
 * convention-break finding. Pure text transform; callers write the file
 * and let the gate judge the result. Returns the new file contents, or
 * undefined when nothing changes (caller must then refuse).
 */
export function applyConventionFix(checkoutDir: string, finding: Finding): string | undefined {
  const convention = finding.convention ? findConvention(finding.convention) : undefined;
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
