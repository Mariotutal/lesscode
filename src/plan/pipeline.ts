import { classifyFindings } from "../classify/classify.js";
import { changedFilesFromGit, scopedReviewFiles } from "../classify/checkout.js";
import type { GuestClient } from "../classify/client.js";
import { createGuestClient } from "../classify/client.js";
import { evaluateGate, type GateResult } from "../gate/gate.js";
import { planOnce, WONDER_MODEL, type PlanResult } from "./plan.js";
import { applyPlan, type ApplyResult } from "./apply.js";

export interface PipelineResult {
  classification: { findings: number; dropped: number; model: string; modelCalls: number; usage?: unknown };
  plan: PlanResult;
  apply: ApplyResult;
  gate: GateResult | null;
  editSet: string[];
}

/**
 * Full run: Spark classifies, Wonder plans ONCE, code applies edits
 * as AST codemods (no repair turn; a non-mechanical edit is skipped),
 * and the gate decides.
 * The gate's base is the PR branch itself: the simplification must
 * shrink the bloated tree relative to bloated-pr, with exports outside
 * the applied edit set unchanged.
 */
export async function runPipeline(opts: {
  checkoutDir: string;
  /** Ref the PR is diffed against for scope-creep (declared intent below). */
  baseRef: string;
  /** Ref the gate diffs the patched worktree against (the PR head). */
  gateBaseRef: string;
  intentFiles: string[];
  relatedTests: string[];
  sparkClient?: GuestClient;
  wonderClient?: GuestClient;
}): Promise<PipelineResult> {
  // package-lock.json is an install artifact of the harness checkout,
  // never PR scope creep.
  const changed = (await changedFilesFromGit(opts.checkoutDir, opts.baseRef)).filter((f) => f !== "package-lock.json");
  const visible = scopedReviewFiles(opts.checkoutDir, { intentFiles: opts.intentFiles, changedFiles: changed, relatedTests: opts.relatedTests });
  const classification = await classifyFindings({
    checkoutDir: opts.checkoutDir,
    files: visible,
    scopeCreep: { changedFiles: changed, intentFiles: opts.intentFiles },
    client: opts.sparkClient,
  });

  const wonder = opts.wonderClient ?? createGuestClient({ env: { ...process.env, META_MODEL: WONDER_MODEL } });
  const plan = await planOnce({ checkoutDir: opts.checkoutDir, findings: classification.findings, files: visible, client: wonder });
  const apply = await applyPlan({
    checkoutDir: opts.checkoutDir,
    baseRef: opts.baseRef,
    findings: classification.findings,
    edits: plan.edits,
    client: wonder,
  });

  // Nothing applied: no patch for the gate to accept (it would reject
  // on size anyway); report refusal without a gate run.
  const gate = apply.editSet.length
    ? await evaluateGate({ repoDir: opts.checkoutDir, baseRef: opts.gateBaseRef, editSet: apply.editSet, relatedTests: opts.relatedTests })
    : null;

  return {
    classification: {
      findings: classification.findings.length,
      dropped: classification.dropped.length,
      model: classification.model,
      modelCalls: classification.modelCalls,
      usage: classification.usage,
    },
    plan,
    apply,
    gate,
    editSet: apply.editSet,
  };
}
