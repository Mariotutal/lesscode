import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { changedFilesFromGit, contextWindow, estimateTokens, readCheckoutSources, scopedReviewFiles } from "../classify/checkout.js";
import type { GuestClient } from "../classify/client.js";
import { classifyFindings } from "../classify/classify.js";
import { createGuestClient } from "../classify/client.js";
import { isSealedPath } from "../classify/evidence.js";
import { buildSymbolGraph } from "../gate/symbolGraph.js";
import { evaluateGate, type GateResult } from "../gate/gate.js";
import { applyPlan } from "../plan/apply.js";
import { planOnce, WONDER_MODEL, type AnyFinding } from "../plan/plan.js";
import type { PlannedEdit, ReviewNoteItem } from "../plan/schema.js";

const exec = promisify(execFile);

export interface SimplifyOptions {
  checkout: string;
  /** Ref the PR (checkout HEAD) is diffed against: the PR's base. */
  base: string;
  /** Required: files the change claimed to touch. Any other changed file is scope creep. */
  intent: string[];
  relatedTests?: string[];
  sparkClient?: GuestClient;
  wonderClient?: GuestClient;
  /**
   * Internal (review): invoked when the gate rejects an edit, so the
   * caller can replace a note item that ordered that edit. Receives
   * (findingIndex, human gate reason). Not part of the public shape.
   */
  onGateRejected?: GateRejectedHook;
}

export interface SimplifyResult {
  verdict: "accepted" | "refused";
  /** Unified diff of the kept edits vs the checkout HEAD (empty when refused). Line count comes from git. */
  patch: string;
  findings: AnyFinding[];
  gate: GateResult | null;
  droppedFindings: number;
  plan: { edits: number; skipped: { findingIndex: number; reason: string }[]; model: string; modelCalls: number; usage?: unknown; review: ReviewNoteItem[] };
  /** Convention names written in the checkout's lesscode-conventions.json. */
  registry: string[];
  /** model's convention-break findings refused because unregistered (note-only practices). */
  refusedConventions: { convention: string; file: string; citations: { file: string; startLine: number; endLine: number }[]; rationale: string }[];
  apply: { applied: unknown[]; skipped: { findingIndex: number; reason: string }[]; repairCalls: number };
  reasons: string[];
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function isTestPath(f: string): boolean {
  return /(^|\/)tests?\//.test(f) || /\.test\.[cm]?[jt]sx?$/.test(f) || isSealedPath(f);
}

/** Public: gate-rejection hook used by review to rewrite the note. */
export type GateRejectedHook = (findingIndex: number, reason: string) => void;

interface Snapshot { file: string; content: string | null }
function snapshot(repo: string, files: string[]): Snapshot[] {
  return files.map((file) => ({ file, content: existsSync(join(repo, file)) ? readFileSync(join(repo, file), "utf8") : null }));
}
function restoreSnap(repo: string, snaps: Snapshot[]): void {
  for (const s of snaps) {
    if (s.content === null) rmSync(join(repo, s.file), { force: true });
    else { mkdirSync(dirname(join(repo, s.file)), { recursive: true }); writeFileSync(join(repo, s.file), s.content); }
  }
}

/**
 * Files whose exports are referenced from other files, per the symbol
 * graph over the given tree. Used by the referenced-symbol guard.
 */
function referencingFiles(tree: Map<string, string>): Map<string, Set<string>> {
  // buildSymbolGraph credits referencedByOthers on the declaring file;
  // invert by scanning importers is not exposed, so recompute: a file's
  // exports are "still referenced" iff referencedByOthers is non-empty.
  const graph = buildSymbolGraph(tree);
  const out = new Map<string, Set<string>>();
  for (const [file, syms] of graph) if (syms.referencedByOthers.size) out.set(file, syms.referencedByOthers);
  return out;
}

/**
 * Hide the pipeline behind one function. Spark classifies, Wonder
 * plans once, code applies edits one at a time in a scratch worktree
 * and keeps an edit only when the gate accepts the cumulative result.
 * Scope creep (diff paths outside `intent`) is restored from `base`
 * by code. The caller checkout/branch is never modified.
 */
export async function simplify(opts: SimplifyOptions): Promise<SimplifyResult> {
  if (!opts.intent || opts.intent.length === 0) throw new Error("intent is required: the list of files the change claimed to touch");
  const checkout = opts.checkout;
  const relatedTests = opts.relatedTests?.length ? opts.relatedTests : ["tests"];
  const headSha = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  const callerHeadBefore = headSha;
  const callerStatusBefore = await git(checkout, ["status", "--porcelain"]);

  const parent = mkdtempSync(join(tmpdir(), "lc-simplify-"));
  const scratch = join(parent, "repo");
  try {
    await exec("git", ["worktree", "add", "--detach", scratch, headSha], { cwd: checkout, maxBuffer: 64 * 1024 * 1024 });
    if (existsSync(join(checkout, "node_modules"))) {
      await exec("ln", ["-s", join(checkout, "node_modules"), join(scratch, "node_modules")]);
    }

    const changed = (await changedFilesFromGit(scratch, opts.base)).filter((f) => f !== "package-lock.json" && !f.endsWith("/") && f !== "node_modules");
    // Review the change, not the whole checkout: models see intent +
    // changed files, their one-hop neighbours, and related tests.
    // If even that cannot fit the window, trim one-hop neighbours
    // (lowest priority last) and fail before any request if the
    // change itself still cannot fit.
    let visible = scopedReviewFiles(scratch, { intentFiles: opts.intent, changedFiles: changed, relatedTests });
    const sparkModel = opts.sparkClient?.config.model ?? "muse-spark-1.3";
    const seeds = new Set([...opts.intent, ...changed]);
    const fits = (files: string[], model: string) => estimateTokens(readCheckoutSources(scratch, files).map((s) => s.text).join("\n")) <= contextWindow(model);
    // Never trim a seed: only one-hop neighbours/related tests go.
    // If the change itself still does not fit, classifyFindings
    // fails before the request with the size in the error.
    while (visible.length && !seeds.has(visible.at(-1)!) && !fits(visible, sparkModel)) visible = visible.slice(0, -1);
    const classification = await classifyFindings({
      checkoutDir: scratch,
      files: visible,
      scopeCreep: { changedFiles: changed, intentFiles: opts.intent },
      client: opts.sparkClient,
    });
    const findings = classification.findings;

    const wonder = opts.wonderClient ?? createGuestClient({ env: { ...process.env, META_MODEL: WONDER_MODEL } });
    const plan = await planOnce({ checkoutDir: scratch, findings, files: visible, client: wonder });

    // Candidate edits: planner's, plus code-mandated scope-creep
    // restores the planner skipped (code decides creep, not the model).
    // Test/sealed creep is never restored — that would delete tests.
    const plannedIdx = new Set(plan.edits.map((e) => e.findingIndex));
    const candidates: PlannedEdit[] = [...plan.edits];
    findings.forEach((f, i) => {
      if (f.category === "scope-creep" && !isTestPath(f.file) && !plannedIdx.has(i)) {
        candidates.push({ findingIndex: i, action: "restore-from-base", newFiles: [], deleteFiles: [], rationale: "code-decided scope creep: restore from base" });
      }
    });

    // Referenced-symbol guard (code): an inline/retarget that deletes
    // a file whose exports other files still reference is refused,
    // unless every file referencing it is rewritten or deleted by
    // that same edit. Importers are computed from the checkout sources
    // (same resolution plan.ts uses for its allowed set).
    const sources = readCheckoutSources(scratch, visible);
    const headTree = new Map(sources.map((s) => [s.file, s.text]));
    const referenced = referencingFiles(headTree);
    const importersOf = (target: string): Set<string> => {
      const stem = target.replace(/\.[cm]?[jt]sx?$/, "");
      const out = new Set<string>();
      for (const s of sources) {
        if (s.file === target) continue;
        for (const m of s.text.matchAll(/from\s+["']([^"']+)["']/g)) {
          const spec = m[1]!;
          if (!spec.startsWith(".")) continue;
          const parts: string[] = [];
          for (const seg of `${s.file.split("/").slice(0, -1).join("/")}/${spec}`.split("/")) {
            if (seg === "..") parts.pop(); else if (seg !== "." && seg !== "") parts.push(seg);
          }
          if (parts.join("/").replace(/\.[cm]?[jt]sx?$/, "") === stem) out.add(s.file);
        }
      }
      return out;
    };

    // Union of every file any candidate edit rewrites or deletes: a
    // referencing file inside this union is handled by the edit chain
    // (and judged by tsc + the gate); a referencing file outside it
    // would be left pointing at a deleted symbol, so that edit is refused.
    const unionTouched = new Set(candidates.flatMap((e) => [...e.newFiles.map((x) => x.file), ...e.deleteFiles]));
    const reasons: string[] = [];
    const edits: PlannedEdit[] = [];
    for (const e of candidates) {
      const f = findings[e.findingIndex];
      if (!f) { reasons.push(`edit for unknown finding ${e.findingIndex} dropped`); continue; }
      if (f.category === "scope-creep" && isTestPath(f.file)) { reasons.push(`scope creep in test path ${f.file} not restored (tests are never deleted)`); continue; }
      if ((e.action === "inline" || e.action === "retarget") && e.deleteFiles.includes(f.file) && referenced.has(f.file)) {
        const unrewritten = [...importersOf(f.file)].filter((x) => !unionTouched.has(x));
        if (unrewritten.length) {
          reasons.push(`finding ${e.findingIndex}: ${f.file} exports still referenced by ${unrewritten.join(", ")}; cannot inline/delete`);
          continue;
        }
      }
      edits.push(e);
    }

    // Per-edit apply + gate in scratch. Invariant: scratch always
    // holds exactly the kept edits (snapshot/restore per edit), so a
    // dropped edit (e.g. fixture 5's complexity edit) never discards
    // an earlier kept edit.
    const keptEditSet: string[] = [];
    const restoreFiles = new Set(findings.filter((f) => f.category === "scope-creep").map((f) => f.file));
    const appliedAll: unknown[] = [];
    const skippedAll: { findingIndex: number; reason: string }[] = [];
    let repairCalls = 0;
    let lastGate: GateResult | null = null;

    for (const edit of edits) {
      const f = findings[edit.findingIndex]!;
      const touchedGuess = [...new Set([
        f.file,
        ...edit.newFiles.map((x) => x.file),
        ...edit.deleteFiles,
      ])];
      const before = snapshot(scratch, [...new Set([...touchedGuess, ...keptEditSet])]);
      const apply = await applyPlan({ checkoutDir: scratch, baseRef: opts.base, findings, edits: [edit], client: wonder });
      repairCalls += apply.repairCalls;
      skippedAll.push(...apply.skipped);
      if (!apply.applied.length) continue;

      const candidateSet = [...new Set([...keptEditSet, ...apply.editSet])];
      const gate = await evaluateGate({ repoDir: scratch, baseRef: headSha, editSet: candidateSet, relatedTests, coverageExempt: candidateSet.filter((f) => restoreFiles.has(f)) });
      lastGate = gate;
      // A lone scope-creep restore shrinks nothing by itself; keep it
      // when every non-size check passes. The final cumulative gate
      // (below) must still accept, so a shorter diff alone never wins.
      const restoreOnly = edit.action === "restore-from-base";
      const keepable = gate.accepted || (restoreOnly && gate.checks.every((c) => c.name === "size-drops" || c.passed));
      if (keepable) {
        keptEditSet.push(...apply.editSet);
        appliedAll.push(...apply.applied);
      } else {
        restoreSnap(scratch, before);
        const failed = gate.checks.filter((c) => !c.passed);
        reasons.push(`finding ${edit.findingIndex} (${edit.action}) dropped: gate rejected (${failed.map((c) => c.name).join(", ")})`);
        opts.onGateRejected?.(edit.findingIndex, `the gate rejected the edit for finding ${edit.findingIndex}: ${failed.map((c) => `${c.name} — ${c.detail}`).join("; ")}`);
      }
    }

    const planSummary = { edits: plan.edits.length, skipped: plan.skipped, model: plan.model, modelCalls: plan.modelCalls, usage: plan.usage, review: plan.review };
    const applySummary = { applied: appliedAll, skipped: skippedAll, repairCalls };
    const refusedConventions = classification.refusedConventions.map((d) => ({
      convention: d.finding.convention ?? "(none)",
      file: d.finding.file,
      citations: d.finding.citations,
      rationale: d.status === "refused" ? d.reason : d.finding.rationale,
    }));

    if (!appliedAll.length) {
      return { verdict: "refused", patch: "", findings, gate: lastGate, droppedFindings: classification.dropped.length, plan: planSummary, apply: applySummary, registry: classification.registry, refusedConventions, reasons };
    }

    const finalEditSet = [...new Set(keptEditSet)];
    const finalGate = await evaluateGate({ repoDir: scratch, baseRef: headSha, editSet: finalEditSet, relatedTests, coverageExempt: finalEditSet.filter((f) => restoreFiles.has(f)) });
    if (!finalGate.accepted) {
      return {
        verdict: "refused", patch: "", findings, gate: finalGate, droppedFindings: classification.dropped.length, plan: planSummary, apply: applySummary, registry: classification.registry, refusedConventions,
        reasons: [...reasons, `final gate rejected: ${finalGate.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}`],
      };
    }

    const patch = await git(scratch, ["-c", "color.ui=false", "diff", "--no-color", headSha, "--", "."]);
    return { verdict: "accepted", patch, findings, gate: finalGate, droppedFindings: classification.dropped.length, plan: planSummary, apply: applySummary, registry: classification.registry, refusedConventions, reasons };
  } finally {
    await exec("git", ["worktree", "remove", "--force", scratch], { cwd: checkout }).catch(() => undefined);
    await exec("git", ["worktree", "prune"], { cwd: checkout }).catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
  }
  // (Caller-checkout immutability is asserted by tests: simplify only
  // ever writes inside the scratch worktree removed above.)
  void callerHeadBefore; void callerStatusBefore;
}
