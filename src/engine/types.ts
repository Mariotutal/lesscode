import type { GuestClient } from "../provider/types.js";
import type { RecoveredFinding } from "../classify/recover.js";
import type { GateResult } from "../gate/gate.js";
import type { RunManifest } from "../manifest.js";
import type { AnyFinding } from "../plan/plan.js";
import type { PlannedEdit, ReviewNoteItem } from "../plan/schema.js";
import type { RepositoryExecutor } from "../execution/index.js";

export interface ReviewRequest {
  checkout: string;
  base: string;
  intent: string[];
  scope?: { kind: "declared" | "inferred"; paths: string[] };
  expectedHeadSha?: string;
  relatedTests?: string[];
  sparkClient?: GuestClient;
  wonderClient?: GuestClient;
  executor?: RepositoryExecutor;
  signal?: AbortSignal;
}

export interface DecisionReason {
  code: "planner-skip" | "unsupported-transform" | "structural-rejection" | "verification-failed" | "invalid-edit";
  stage: "plan" | "prepare" | "structural" | "verification";
  detail: string;
}

export interface EditOutcome {
  findingId: string;
  findingIndex: number;
  action: PlannedEdit["action"];
  status: "kept" | "skipped" | "rejected" | "withdrawn";
  files: string[];
  reason?: DecisionReason;
}

export interface ReviewNote { items: ReviewNoteItem[]; markdown: string }

export interface RunAudit {
  droppedFindings: number;
  recoveredFindings: RecoveredFinding[];
  registry: string[];
  unknownConventions: string[];
  refusedConventions: { convention: string; file: string; citations: ReviewNoteItem["citations"]; rationale: string }[];
  plan: { edits: number; skipped: { findingIndex: number; reason: string }[]; model: string; modelCalls: number; usage?: unknown; review: ReviewNoteItem[] };
  reasons: string[];
  tsConfig: { allowJs: boolean; checkJs: boolean };
}

/** Serialized product contract shared by local callers and hosted workers. */
export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  state: "completed" | "failed" | "cancelled";
  verdict: "accepted" | "reviewed" | "failed";
  outcome: "patch-ready" | "review-only" | "no-change" | "unverified" | null;
  revision: { headSha: string; baseSha: string; scope: "declared" | "inferred" } | null;
  execution: { kind: RepositoryExecutor["kind"]; policyVersion: 1; environmentId?: string };
  findings: AnyFinding[];
  findingIds: string[];
  edits: EditOutcome[];
  gate: GateResult | null;
  verification: { status: "verified" | "rejected" | "not-run"; treeHash: string | null };
  artifact: { headSha: string; baseSha: string; patch: string; sha256: string; treeHash: string; paths: string[] } | null;
  review: ReviewNote;
  manifest: RunManifest;
  audit: RunAudit;
  failure: { stage: string; message: string } | null;
}
