import type { GuestClient } from "../classify/client.js";
import { citationExists } from "../classify/evidence.js";
import { changedFilesFromGit, changedLinesFromGit, matchesIntent, readTsConfig, scopedReviewFiles } from "../classify/checkout.js";
import type { GateResult } from "../gate/gate.js";
import type { AnyFinding } from "../plan/plan.js";
import type { ReviewNoteItem } from "../plan/schema.js";
import { simplify } from "../simplify/simplify.js";
import type { RunManifest } from "../manifest.js";

export interface ReviewOptions {
  checkout: string;
  /** Ref the PR (checkout HEAD) is diffed against: the PR's base. */
  base: string;
  /** Required: files the change claimed to touch. Any other changed file is scope creep. */
  intent: string[];
  relatedTests?: string[];
  sparkClient?: GuestClient;
  wonderClient?: GuestClient;
}

export interface ReviewNote {
  items: ReviewNoteItem[];
  /** Markdown rendering of the kept items (each cites a line). Empty when no item survives. */
  markdown: string;
}

export interface ReviewResult {
  /** Gate-accepted patch (same string simplify returns). Empty when none survive. */
  applied: string;
  /** Cited senior note. Never applied. Returned even when `applied` is empty. */
  review: ReviewNote;
  /**
   * accepted — patch non-empty and gate passed.
   * reviewed — the note is the result and nothing was applied (a success).
   * failed   — only when the run itself could not finish.
   */
  verdict: "accepted" | "reviewed" | "failed";
  findings: AnyFinding[];
  gate: GateResult | null;
  /** LES-26 run manifest from simplify (null when the run failed). */
  manifest: RunManifest | null;
  /** Human-readable run rendering from simplify (next to the CLI JSON). */
  summary: string;
  /** Audit fields carried through from simplify (not part of the public five). */
  detail: {
    reasons: string[];
    droppedFindings: number;
    registry: string[];
    unknownConventions: string[];
    tsConfig: { allowJs: boolean; checkJs: boolean };
    error?: string;
  };
}

function renderMarkdown(items: ReviewNoteItem[]): string {
  if (!items.length) return "";
  const lines = items.map((item) => {
    const cites = item.citations.map((c) => `${c.file}:${c.startLine}-${c.endLine}`).join(", ");
    return `- (${item.kind}) ${item.text} [${cites}]`;
  });
  return ["## Lead review", "", ...lines, ""].join("\n");
}

/**
 * review(checkout, base, intent) — the lead review in front of the
 * current checker (`simplify`). It does not throw simplify away and
 * does not re-decide anything: Spark classifies, Wonder is called
 * ONCE and returns the edit plan and the note together, code applies
 * edits in a scratch worktree, and the deterministic gate accepts or
 * rejects each one.
 *
 * Code filters the note: an item whose citation does not exist is
 * dropped; an item that orders an edit the gate rejected is replaced
 * with the gate reason. A practice the repository has not written in
 * its convention registry is refused as an edit by the classifier and
 * surfaces here as a `practice` note item — never in `applied`.
 */
export async function review(opts: ReviewOptions): Promise<ReviewResult> {
  const tsConfig = opts.intent?.length ? readTsConfig(opts.checkout) : { allowJs: false, checkJs: false };
  const gateRejections = new Map<number, string>();
  try {
    const result = await simplify({
      checkout: opts.checkout,
      base: opts.base,
      intent: opts.intent,
      relatedTests: opts.relatedTests,
      sparkClient: opts.sparkClient,
      wonderClient: opts.wonderClient,
      onGateRejected: (findingIndex, reason) => gateRejections.set(findingIndex, reason),
    });

    // Filter the note by code. Citations are checked against the
    // caller checkout (same tree the scratch worktree started from).
    // The note is about the change: an item citing a file outside the
    // scoped (visible) set is dropped even when the line exists.
    const changed = await changedFilesFromGit(opts.checkout, opts.base).catch(() => []);
    const visible = new Set(scopedReviewFiles(opts.checkout, { intentFiles: opts.intent, changedFiles: changed, relatedTests: opts.relatedTests }));
    // The note is about the change: items must cite a changed line, or
    // say the change itself is sound before anything else. Cited lines
    // in intent files that the PR did not change are context, not note.
    const changedLines = await changedLinesFromGit(opts.checkout, opts.base).catch(() => new Map<string, Set<number>>());
    const intentChanged = changed.filter((f) => matchesIntent(f, opts.intent));
    const onChangedLine = (item: ReviewNoteItem): boolean => intentChanged.length === 0 || item.citations.some((c) => {
      const lines = changedLines.get(c.file);
      return !!lines && [...lines].some((n) => n >= c.startLine && n <= c.endLine);
    });
    const saysSound = (item: ReviewNoteItem): boolean => /change itself is sound|change is sound|^sound\b/i.test(item.text.trim());
    const reasons = [...result.reasons];
    const items: ReviewNoteItem[] = [];
    for (const item of result.plan.review) {
      if (!item.citations.every((c) => visible.has(c.file) && citationExists(opts.checkout, c))) continue; // dropped
      if (!onChangedLine(item) && !saysSound(item)) { reasons.push(`note item dropped: it does not cite a line the pull request changed and does not say the change itself is sound first: ${item.text}`); continue; }
      const rejected = item.ordersEditForFinding !== undefined ? gateRejections.get(item.ordersEditForFinding) : undefined;
      if (rejected !== undefined) {
        items.push({ ...item, text: `Not applied: ${rejected}`, ordersEditForFinding: undefined });
        reasons.push(`finding ${item.ordersEditForFinding} kept and produces no patch: ${rejected}`);
      } else {
        items.push(item);
      }
    }
    // A kept finding that produced no patch records the reason.
    const appliedPatch = result.verdict === "accepted" ? result.patch : "";
    if (!appliedPatch && result.findings.length && !reasons.some((r) => /kept.*no patch|produces no patch/i.test(r))) {
      reasons.push(`kept finding(s) ${result.findings.map((f) => `${f.category} in ${f.file}`).join(", ")} produced no patch: no gate-accepted edit was applied`);
    }
    // Practices outside the registry: refused as edits, kept as note.
    for (const refused of result.refusedConventions) {
      if (items.some((i) => i.kind === "practice" && i.citations[0]?.file === refused.file)) continue;
      if (!refused.citations.every((c) => visible.has(c.file) && citationExists(opts.checkout, c))) continue;
      items.push({
        kind: "practice",
        text: `Practice "${refused.convention}" is not written in this repository's convention registry, so it is not applied: ${refused.rationale}`,
        citations: refused.citations,
      });
    }

    const applied = result.verdict === "accepted" ? result.patch : "";
    return {
      applied,
      review: { items, markdown: renderMarkdown(items) },
      verdict: applied ? "accepted" : "reviewed",
      findings: result.findings,
      gate: result.gate,
      manifest: result.manifest,
      summary: result.summary,
      detail: {
        reasons,
        droppedFindings: result.droppedFindings,
        registry: result.registry,
        unknownConventions: result.unknownConventions,
        tsConfig,
      },
    };
  } catch (e) {
    // failed only when the run itself could not finish.
    return {
      applied: "",
      review: { items: [], markdown: "" },
      verdict: "failed",
      findings: [],
      gate: null,
      manifest: null,
      summary: "",
      detail: {
        reasons: [],
        droppedFindings: 0,
        registry: [],
        unknownConventions: [],
        tsConfig,
        error: e instanceof Error ? e.message : String(e),
      },
    };
  }
}
