import type { GateResult } from "../gate/gate.js";
import type { AnyFinding } from "../plan/plan.js";
import type { RecoveredFinding } from "../classify/recover.js";
import type { RunManifest } from "../manifest.js";
import { runReview, renderRecordSummary } from "../engine/run.js";
import type { ReviewRequest, RunRecord, ReviewNote } from "../engine/types.js";
type SimplifyResultRecovered = RecoveredFinding[];
export type ReviewOptions = ReviewRequest;
export type { ReviewNote } from "../engine/types.js";

export interface ReviewResult {
  /** Canonical versioned result; present on all real engine runs. */
  run?: RunRecord;
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
    recoveredFindings: SimplifyResultRecovered;
    registry: string[];
    unknownConventions: string[];
    tsConfig: { allowJs: boolean; checkJs: boolean };
    error?: string;
  };
}

/** Compatibility projection; all decisions and citation filtering belong to the engine. */
export async function review(opts: ReviewOptions): Promise<ReviewResult> {
  const run = await runReview(opts);
  return {
    run, applied: run.artifact?.patch ?? "", review: run.review, verdict: run.verdict, findings: run.findings,
    gate: run.gate, manifest: run.manifest, summary: renderRecordSummary(run),
    detail: { reasons: run.audit.reasons, droppedFindings: run.audit.droppedFindings,
      recoveredFindings: run.audit.recoveredFindings, registry: run.audit.registry,
      unknownConventions: run.audit.unknownConventions, tsConfig: run.audit.tsConfig,
      ...(run.failure ? { error: run.failure.message } : {}),
    },
  };
}
