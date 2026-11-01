import type { FindingCategory } from "../src/classify/schema.js";

/**
 * Evaluation corpus types (LES-27). A case is a small synthetic or
 * fixture-shaped checkout with KNOWN answers: the findings a correct
 * classifier reports, the verdict a correct gate reaches, and the
 * scripted-model responses used in `npm test` (the live runner
 * replaces the script with real models and records the diff).
 * No case reads, copies, or references any fixtures/<n>/sealed tree.
 */

export interface ExpectedFinding {
  category: FindingCategory;
  file: string;
}

/** One scripted (or, live, expected-Shaped) model finding. */
export interface ScriptedFinding {
  category: string;
  file: string;
  citations: { file: string; startLine: number; endLine: number }[];
  existingHelperFile?: string;
  convention?: string;
  rationale: string;
}

export interface EvalCase {
  id: string;
  /** What the case probes, in one sentence. */
  probes: string;
  /** Directory under eval/cases/<id>/ holding base/ and head/ snapshots. */
  dir: string;
  intent: string[];
  relatedTests?: string[];
  /** Known answers: the findings a correct run reports (after code verification). */
  expectedFindings: ExpectedFinding[];
  expectedVerdict: "accepted" | "reviewed" | "failed";
  /** Scripted Spark output for the npm-test run. */
  spark: ScriptedFinding[];
  /** Spark findings that code must drop (false positives the script emits on purpose); scored against `expectedFindings`. */
  wonder: { findingIndex: number; action: string; rationale: string }[];
  /** Expected Wonder review note (scripted). */
  wonderReview: { kind: string; text: string; citations: { file: string; startLine: number; endLine: number }[] }[];
}
