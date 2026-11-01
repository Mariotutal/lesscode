import type { RecoveredFinding } from "../classify/recover.js";
import type { GateResult } from "../gate/gate.js";
import type { RunManifest } from "../manifest.js";
import type { AnyFinding } from "../plan/plan.js";
import type { ReviewNoteItem } from "../plan/schema.js";
import { runReview, renderRecordSummary } from "../engine/run.js";
import type { ReviewRequest, RunRecord } from "../engine/types.js";

export type GateRejectedHook = (findingIndex: number, reason: string) => void;
export interface SimplifyOptions extends ReviewRequest {
  /** Compatibility hook; new callers consume RunRecord.edits. */
  onGateRejected?: GateRejectedHook;
}

export interface SimplifyResult {
  verdict: "accepted" | "refused";
  /** Unified diff of the kept edits vs the checkout HEAD (empty when refused). Line count comes from git. */
  patch: string;
  findings: AnyFinding[];
  gate: GateResult | null;
  droppedFindings: number;
  /** Findings recovered in code after a citation slip (LES-30): which finding, which symbol, citations before/after. */
  recoveredFindings: RecoveredFinding[];
  plan: { edits: number; skipped: { findingIndex: number; reason: string }[]; model: string; modelCalls: number; usage?: unknown; review: ReviewNoteItem[] };
  /** Convention names written in the checkout's lesscode-conventions.json. */
  registry: string[];
  unknownConventions: string[];
  /** model's convention-break findings refused because unregistered (note-only practices). */
  refusedConventions: { convention: string; file: string; citations: { file: string; startLine: number; endLine: number }[]; rationale: string }[];
  apply: { applied: unknown[]; skipped: { findingIndex: number; reason: string }[]; repairCalls: number };
  reasons: string[];
  /** LES-26 run manifest: models, call count, usage, phase times, prompt hashes. No credential/prompt text. */
  manifest: RunManifest;
  /** Short human-readable rendering: findings/edits kept and dropped with reasons, verdict. */
  summary: string;
}

export function projectSimplification(record: RunRecord): SimplifyResult {
  return {
    verdict: record.artifact ? "accepted" : "refused",
    patch: record.artifact?.patch ?? "", findings: record.findings, gate: record.gate,
    droppedFindings: record.audit.droppedFindings, recoveredFindings: record.audit.recoveredFindings,
    plan: record.audit.plan, registry: record.audit.registry, unknownConventions: record.audit.unknownConventions,
    refusedConventions: record.audit.refusedConventions,
    apply: {
      applied: record.edits.filter((e) => e.status === "kept").map((e) => ({ findingIndex: e.findingIndex, action: e.action, files: e.files, repaired: false })),
      skipped: record.edits.filter((e) => e.status !== "kept").map((e) => ({ findingIndex: e.findingIndex, reason: e.reason?.detail ?? e.status })), repairCalls: 0,
    },
    reasons: record.audit.reasons, manifest: record.manifest,
    summary: renderRecordSummary(record).replace("Verdict: reviewed", "Verdict: refused"),
  };
}

/** Legacy patch-only projection of the shared review engine. */
export async function simplify(opts: SimplifyOptions): Promise<SimplifyResult> {
  const record = await runReview(opts);
  if (record.failure) throw new Error(record.failure.message);
  for (const outcome of record.edits) if (outcome.status !== "kept") opts.onGateRejected?.(outcome.findingIndex, outcome.reason?.detail ?? outcome.status);
  return projectSimplification(record);
}
