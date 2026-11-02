import { createHash } from "node:crypto";
import type { ChatMessage } from "./provider/types.js";

/**
 * Run manifest (LES-26): returned with every simplify/review result.
 * It names the models, counts model calls, sums token usage, times
 * each phase, and hashes the prompts sent. It never contains the
 * credential, the prompt text, or any secret — only SHA-256 hashes.
 */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ModelPricing { inputPerMtok?: number; outputPerMtok?: number; source?: string; version?: string }

/** Incomplete cost: some billable usage could not be priced */
export interface UnpricedUsage { role: "spark" | "wonder"; model: string; prompt_tokens: number; completion_tokens: number; total_tokens: number; reason: string }

/** Derived cost in USD. */
export interface RunCost {
  currency: "USD";
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  byRole: { spark?: { inputUsd: number; outputUsd: number; totalUsd: number }; wonder?: { inputUsd: number; outputUsd: number; totalUsd: number } };
  completeness: "complete" | "partial" | "unknown";
  unpriced: UnpricedUsage[];
  pricingSource: string;
}

/**
 * Default pricing table (USD per 1M tokens), used when `.lesscode.json`
 * has no `pricing` entry for the model. These are estimates for
 * cost visibility only — override them per model in `.lesscode.json`.
 * A missing entry means no cost is derived; cost never gates a run.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "muse-spark-1.3": { inputPerMtok: 0.5, outputPerMtok: 1.5, source: "builtin", version: "2026-01-01" },
  "muse-wonder-1.0": { inputPerMtok: 3, outputPerMtok: 15, source: "builtin", version: "2026-01-01" },
};

function isFiniteNonNeg(n: unknown): n is number { return typeof n==="number" && Number.isFinite(n) && n>=0; }

export function validateUsage(u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): { valid: boolean; usage?: TokenUsage; reason?: string } {
  if (!u) return { valid:false, reason:"usage not reported" };
  const hasPrompt = u.prompt_tokens !== undefined, hasCompletion = u.completion_tokens !== undefined;
  if (!hasPrompt && !hasCompletion && u.total_tokens===undefined) return { valid:false, reason:"usage not reported" };
  if (hasPrompt && !isFiniteNonNeg(u.prompt_tokens)) return { valid:false, reason:"invalid prompt_tokens" };
  if (hasCompletion && !isFiniteNonNeg(u.completion_tokens)) return { valid:false, reason:"invalid completion_tokens" };
  if (u.total_tokens!==undefined && !isFiniteNonNeg(u.total_tokens)) return { valid:false, reason:"invalid total_tokens" };
  return { valid:true, usage:{ prompt_tokens: u.prompt_tokens??0, completion_tokens: u.completion_tokens??0, total_tokens: u.total_tokens ?? ((u.prompt_tokens??0)+(u.completion_tokens??0)) } };
}

/** Price one role's usage; undefined when no rate is known for the model. */
export function priceUsage(model: string | undefined, usage: TokenUsage, pricing?: Record<string, ModelPricing>): RunCost["byRole"]["spark"] | undefined {
  if (!model) return undefined;
  const rate = pricing?.[model] ?? DEFAULT_PRICING[model];
  if (!rate || (rate.inputPerMtok === undefined && rate.outputPerMtok === undefined)) return undefined;
  // partial rates: price only the side with a rate, other side unpriced is handled by caller completeness
  if ((usage.prompt_tokens>0 && rate.inputPerMtok===undefined) || (usage.completion_tokens>0 && rate.outputPerMtok===undefined)) return undefined;
  const inputUsd = (usage.prompt_tokens / 1_000_000) * (rate.inputPerMtok ?? 0);
  const outputUsd = (usage.completion_tokens / 1_000_000) * (rate.outputPerMtok ?? 0);
  return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
}

export interface RunManifest {
  models: { spark: string; wonder: string };
  /** Model id the provider actually returned in `response.model`, per role, when it sent one. Auditable against the gateway. */
  responseModels: { spark?: string; wonder?: string };
  modelCalls: number;
  /** Per-model call counts (includes Spark's one validation retry when taken). */
  callsByModel: { spark: number; wonder: number };
  usage: TokenUsage;
  /** Wall-clock milliseconds per phase; they sum to totalMs. */
  phasesMs: { resolve: number; prepare: number; classify: number; plan: number; apply: number; gate: number; finalize: number; cleanup: number; overhead: number };
  totalMs: number;
  /** SHA-256 (hex) of each prompt sent, in send order. Hashes only. */
  promptHashes: string[];
  /** Pricing applied per role (after `.lesscode.json` / default-table lookup), when known. */
  pricing?: { spark?: ModelPricing; wonder?: ModelPricing };
  /** Derived from `usage` and pricing. Informational only; never blocks the gate. */
  cost?: RunCost;
}

export function hashPrompt(messages: readonly ChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

export function emptyUsage(): TokenUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

export function addUsage(into: TokenUsage, u?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): TokenUsage {
  if (!u) return into;
  into.prompt_tokens += u.prompt_tokens ?? 0;
  into.completion_tokens += u.completion_tokens ?? 0;
  into.total_tokens += u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0));
  return into;
}

/** Accumulator threaded through a run; phases timed by the caller. */
export class ManifestBuilder {
  readonly phasesMs = { resolve: 0, prepare: 0, classify: 0, plan: 0, apply: 0, gate: 0, finalize: 0, cleanup: 0, overhead: 0 };
  readonly usage = emptyUsage();
  readonly promptHashes: string[] = [];
  sparkCalls = 0;
  wonderCalls = 0;
  sparkModel = "";
  wonderModel = "";
  readonly responseModels: { spark?: string; wonder?: string } = {};
  readonly usageByRole: Record<"spark" | "wonder", TokenUsage> = { spark: emptyUsage(), wonder: emptyUsage() };
  readonly pricingByRole: Record<"spark" | "wonder", Record<string, ModelPricing> | undefined> = { spark: undefined, wonder: undefined };
  readonly calls: { role: "spark"|"wonder"; model: string; usage?: TokenUsage; invalidReason?: string }[] = [];
  readonly unpriced: UnpricedUsage[] = [];

  /** Record one response: aggregate + per-role usage, and the provider-returned model id. */
  recordResponse(role: "spark" | "wonder", usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }, responseModel?: string): void {
    const model = responseModel ?? (role==="spark"? this.sparkModel : this.wonderModel);
    if (responseModel) this.responseModels[role] = responseModel;
    const v = validateUsage(usage);
    if (!v.valid) {
      // distinguish omitted vs invalid; don't add to totals
      this.calls.push({ role, model: model||"(unknown)", invalidReason: v.reason });
      if (usage !== undefined) this.unpriced.push({ role, model: model||"(unknown)", prompt_tokens:0, completion_tokens:0, total_tokens:0, reason: v.reason! });
      return;
    }
    // zero usage is valid but not billable
    addUsage(this.usage, v.usage);
    addUsage(this.usageByRole[role], v.usage);
    this.calls.push({ role, model: model||"(unknown)", usage: v.usage });
  }

  setPricing(role: "spark" | "wonder", pricing?: Record<string, ModelPricing>): void {
    if (pricing) this.pricingByRole[role] = pricing;
  }
  private readonly started = performance.now();

  /** Time an async phase; the elapsed ms is added to that phase. */
  async time<T>(phase: keyof RunManifest["phasesMs"], fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.phasesMs[phase] += performance.now() - t0;
    }
  }

  build(): RunManifest {
    const totalMs = performance.now() - this.started;
    const measured = Object.entries(this.phasesMs).filter(([phase]) => phase !== "overhead").reduce((sum, [, ms]) => sum + ms, 0);
    this.phasesMs.overhead = Math.max(0, totalMs - measured);
    const byRole: RunCost["byRole"] = {};
    const pricing: NonNullable<RunManifest["pricing"]> = {};
    const byRoleAgg: Record<string, TokenUsage> = {};
    const unpriced: UnpricedUsage[] = [...this.unpriced];
    // price per call by actual model, aggregating
    for (const c of this.calls) {
      if (!c.usage) continue;
      // skip zero-usage calls for pricing
      if (c.usage.prompt_tokens===0 && c.usage.completion_tokens===0) continue;
      const priced = priceUsage(c.model, c.usage, this.pricingByRole[c.role]);
      if (priced) {
        const agg = byRole[c.role] ?? (byRole[c.role] = { inputUsd:0, outputUsd:0, totalUsd:0 });
        agg.inputUsd += priced.inputUsd; agg.outputUsd += priced.outputUsd; agg.totalUsd += priced.totalUsd;
      } else {
        const rate = this.pricingByRole[c.role]?.[c.model] ?? DEFAULT_PRICING[c.model];
        let reason = "unknown model pricing";
        if (rate && ((c.usage.prompt_tokens>0 && rate.inputPerMtok===undefined) || (c.usage.completion_tokens>0 && rate.outputPerMtok===undefined))) reason="partial rate missing input/output price";
        unpriced.push({ role: c.role, model: c.model, prompt_tokens: c.usage.prompt_tokens, completion_tokens: c.usage.completion_tokens, total_tokens: c.usage.total_tokens, reason });
      }
      // collect pricing source
      const effective = c.model;
      const rate = this.pricingByRole[c.role]?.[effective] ?? DEFAULT_PRICING[effective];
      if (rate && !pricing[c.role]) pricing[c.role]=rate;
    }
    // determine completeness
    const hasBillableCalls = this.calls.some(c=>c.usage && (c.usage.prompt_tokens>0 || c.usage.completion_tokens>0));
    const hasPriced = Object.keys(byRole).length>0;
    const completeness: RunCost["completeness"] = !hasBillableCalls ? "unknown" : unpriced.length===0 && hasPriced ? "complete" : hasPriced ? "partial" : "unknown";
    const pricingSource = Object.values(pricing).some(r=>r.source==="builtin") ? "builtin+override" : Object.keys(pricing).length?"custom":"none";
    const cost: RunCost | undefined = (hasPriced || unpriced.length>0)
      ? { currency: "USD", inputUsd: (byRole.spark?.inputUsd ?? 0) + (byRole.wonder?.inputUsd ?? 0), outputUsd: (byRole.spark?.outputUsd ?? 0) + (byRole.wonder?.outputUsd ?? 0), totalUsd: (byRole.spark?.totalUsd ?? 0) + (byRole.wonder?.totalUsd ?? 0), byRole, completeness, unpriced, pricingSource }
      : undefined;
    return {
      models: { spark: this.sparkModel, wonder: this.wonderModel },
      responseModels: { ...this.responseModels },
      modelCalls: this.sparkCalls + this.wonderCalls,
      callsByModel: { spark: this.sparkCalls, wonder: this.wonderCalls },
      usage: { ...this.usage },
      phasesMs: { ...this.phasesMs },
      totalMs,
      promptHashes: [...this.promptHashes],
      ...(Object.keys(pricing).length ? { pricing } : {}),
      ...(cost ? { cost } : {}),
    };
  }
}

export interface HumanRunSummary {
  verdict: string;
  findingsKept: { label: string; reason?: string }[];
  findingsDropped: { label: string; reason: string }[];
  editsKept: { label: string }[];
  editsDropped: { label: string; reason: string }[];
  manifest: RunManifest;
}

/** Short human-readable rendering printed next to the CLI JSON. */
export function renderRunSummary(s: HumanRunSummary): string {
  const lines: string[] = ["## LessCode run", "", `Verdict: ${s.verdict}`, ""];
  lines.push("Findings kept:");
  if (s.findingsKept.length) for (const f of s.findingsKept) lines.push(`- ${f.label}${f.reason ? ` — ${f.reason}` : ""}`);
  else lines.push("- (none)");
  lines.push("", "Findings dropped:");
  if (s.findingsDropped.length) for (const f of s.findingsDropped) lines.push(`- ${f.label} — ${f.reason}`);
  else lines.push("- (none)");
  lines.push("", "Edits kept:");
  if (s.editsKept.length) for (const e of s.editsKept) lines.push(`- ${e.label}`);
  else lines.push("- (none)");
  lines.push("", "Edits dropped:");
  if (s.editsDropped.length) for (const e of s.editsDropped) lines.push(`- ${e.label} — ${e.reason}`);
  else lines.push("- (none)");
  const m = s.manifest;
  const ms = (n: number) => `${n.toFixed(1)}ms`;
  lines.push(
    "",
    `Models: spark=${m.models.spark}, wonder=${m.models.wonder}; calls=${m.modelCalls} (spark ${m.callsByModel.spark}, wonder ${m.callsByModel.wonder})`,
    `Tokens: prompt=${m.usage.prompt_tokens}, completion=${m.usage.completion_tokens}, total=${m.usage.total_tokens}`,
    ...(m.cost ? [(m.cost.completeness==="complete" ? `Cost (estimated, ${m.cost.pricingSource}): $${m.cost.totalUsd.toFixed(6)} (input $${m.cost.inputUsd.toFixed(6)}, output $${m.cost.outputUsd.toFixed(6)})` : `Cost (partial, known subtotal $${m.cost.totalUsd.toFixed(6)}; unpriced: ${m.cost.unpriced.map(u=>`${u.role}/${u.model} ${u.reason}`).join(", ")})`)] : []),
    ...(m.responseModels.spark || m.responseModels.wonder ? [`Response models: spark=${m.responseModels.spark ?? "(none reported)"}, wonder=${m.responseModels.wonder ?? "(none reported)"}`] : []),
    `Phases: ${Object.entries(m.phasesMs).map(([phase, duration]) => `${phase}=${ms(duration)}`).join(", ")}, total=${ms(m.totalMs)}`,
    `Prompt hashes: ${m.promptHashes.length ? m.promptHashes.join(", ") : "(none)"}`,
    "",
  );
  return lines.join("\n");
}
