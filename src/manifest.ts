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

export interface ModelPricing { inputPerMtok?: number; outputPerMtok?: number }

/** Derived cost in USD. Present only when a pricing entry matched a model that reported usage. */
export interface CostEntry { model: string; pricingSource: "custom" | "default"; inputPerMtok?: number; outputPerMtok?: number; inputUsd: number; outputUsd: number; totalUsd: number; promptTokens: number; completionTokens: number }
export interface UnpricedEntry { role: "spark" | "wonder"; model: string; promptTokens: number; completionTokens: number; totalTokens: number; reason: string }
export interface RunCost {
  currency: "USD";
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  byRole: { spark?: { inputUsd: number; outputUsd: number; totalUsd: number }; wonder?: { inputUsd: number; outputUsd: number; totalUsd: number } };
  completeness: "complete" | "partial" | "unknown";
  priced: CostEntry[];
  unpriced: UnpricedEntry[];
  pricingVersion?: string;
}

/**
 * Default pricing table (USD per 1M tokens), used when `.lesscode.json`
 * has no `pricing` entry for the model. These are starting estimates for
 * cost visibility only — override them per model in `.lesscode.json`.
 * A missing entry means no cost is derived; cost never gates a run.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "muse-spark-1.3": { inputPerMtok: 0.5, outputPerMtok: 1.5 },
  "muse-wonder-1.0": { inputPerMtok: 3, outputPerMtok: 15 },
};

function validFinite(n: unknown): n is number { return typeof n === "number" && Number.isFinite(n) && n >= 0; }
/** Price one role's usage; undefined when no rate is known for the model. */
export function priceUsage(model: string | undefined, usage: TokenUsage, pricing?: Record<string, ModelPricing>): RunCost["byRole"]["spark"] | undefined {
  if (!model || (usage.prompt_tokens === 0 && usage.completion_tokens === 0)) return undefined;
  if (!validFinite(usage.prompt_tokens) || !validFinite(usage.completion_tokens)) return undefined;
  const rate = pricing?.[model] ?? DEFAULT_PRICING[model];
  if (!rate || (rate.inputPerMtok === undefined && rate.outputPerMtok === undefined)) return undefined;
  if ((rate.inputPerMtok !== undefined && !validFinite(rate.inputPerMtok)) || (rate.outputPerMtok !== undefined && !validFinite(rate.outputPerMtok))) return undefined;
  // partial rates: price only known side, caller decides completeness
  const inputUsd = (usage.prompt_tokens / 1_000_000) * (rate.inputPerMtok ?? 0);
  const outputUsd = (usage.completion_tokens / 1_000_000) * (rate.outputPerMtok ?? 0);
  return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
}
// helper for RunCost building
function pricingSource(model: string, pricing?: Record<string, ModelPricing>): "custom" | "default" | undefined {
  if (pricing?.[model]) return "custom"; if (DEFAULT_PRICING[model]) return "default"; return undefined;
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
  // per-call attribution: each call keeps its served model so retries with different model ids don't overwrite
  readonly calls: { role: "spark" | "wonder"; model: string; usage: TokenUsage; hasUsage: boolean }[] = [];
  readonly pricingVersion = "lesscode-pricing-v1";

  /** Record one response: aggregate + per-role usage, and the provider-returned model id. */
  recordResponse(role: "spark" | "wonder", usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }, responseModel?: string): void {
    const hasUsage = usage != null && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined || usage.total_tokens !== undefined);
    if (hasUsage) { addUsage(this.usage, usage); addUsage(this.usageByRole[role], usage); }
    if (responseModel) this.responseModels[role] = responseModel;
    const effective = responseModel ?? (role === "spark" ? this.sparkModel : this.wonderModel);
    const norm: TokenUsage = { prompt_tokens: validFinite(usage?.prompt_tokens) ? usage!.prompt_tokens! : 0, completion_tokens: validFinite(usage?.completion_tokens) ? usage!.completion_tokens! : 0, total_tokens: validFinite(usage?.total_tokens) ? usage!.total_tokens! : ((usage?.prompt_tokens ?? 0)+(usage?.completion_tokens ?? 0)) };
    this.calls.push({ role, model: effective || "unknown", usage: norm, hasUsage: !!hasUsage && (validFinite(usage?.prompt_tokens) || validFinite(usage?.completion_tokens) || validFinite(usage?.total_tokens)) });
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
    const priced: CostEntry[] = [];
    const unpriced: UnpricedEntry[] = [];
    // aggregate by role+model from per-call evidence
    const grouped = new Map<string, { role:"spark"|"wonder"; model:string; usage:TokenUsage }>();
    for (const c of this.calls) if (c.hasUsage) { const k=`${c.role}|${c.model}`; const g=grouped.get(k) ?? { role:c.role, model:c.model, usage:emptyUsage()}; addUsage(g.usage,c.usage); grouped.set(k,g); }
    // also detect roles that had calls but no usage reported -> they are absent usage, not zero
    for (const role of ["spark","wonder"] as const) {
      const effective = this.responseModels[role] ?? (role === "spark" ? this.sparkModel : this.wonderModel);
      const rate = effective ? (this.pricingByRole[role]?.[effective] ?? DEFAULT_PRICING[effective]) : undefined;
      if (rate) pricing[role] = rate;
    }
    for (const g of grouped.values()) {
      const rolePricing = this.pricingByRole[g.role];
      const rate = rolePricing?.[g.model] ?? DEFAULT_PRICING[g.model];
      if (!rate || (rate.inputPerMtok===undefined && rate.outputPerMtok===undefined)) { unpriced.push({ role:g.role, model:g.model, promptTokens:g.usage.prompt_tokens, completionTokens:g.usage.completion_tokens, totalTokens:g.usage.total_tokens, reason:"unknown model rate"}); continue; }
      if (g.usage.prompt_tokens>0 && rate.inputPerMtok===undefined) { unpriced.push({ role:g.role, model:g.model, promptTokens:g.usage.prompt_tokens, completionTokens:0, totalTokens:g.usage.prompt_tokens, reason:"missing input rate"}); }
      if (g.usage.completion_tokens>0 && rate.outputPerMtok===undefined) { unpriced.push({ role:g.role, model:g.model, promptTokens:0, completionTokens:g.usage.completion_tokens, totalTokens:g.usage.completion_tokens, reason:"missing output rate"}); }
      const src = pricingSource(g.model, rolePricing)!;
      const inputUsd = g.usage.prompt_tokens>0 && rate.inputPerMtok!==undefined ? (g.usage.prompt_tokens/1e6)*rate.inputPerMtok : 0;
      const outputUsd = g.usage.completion_tokens>0 && rate.outputPerMtok!==undefined ? (g.usage.completion_tokens/1e6)*rate.outputPerMtok : 0;
      if (inputUsd||outputUsd) priced.push({ model:g.model, pricingSource:src, inputPerMtok:rate.inputPerMtok, outputPerMtok:rate.outputPerMtok, inputUsd, outputUsd, totalUsd: inputUsd+outputUsd, promptTokens:g.usage.prompt_tokens, completionTokens:g.usage.completion_tokens});
      else if (g.usage.prompt_tokens===0 && g.usage.completion_tokens===0) { /* zero usage: no entry */ }
    }
    for (const e of priced) { const role = [...grouped.values()].find(v=>v.model===e.model)?.role; if(!role) continue; const cur=byRole[role]??{inputUsd:0,outputUsd:0,totalUsd:0}; cur.inputUsd+=e.inputUsd; cur.outputUsd+=e.outputUsd; cur.totalUsd+=e.totalUsd; byRole[role]=cur; }
    const hasBillableUsage = grouped.size>0 && [...grouped.values()].some(g=>g.usage.prompt_tokens>0||g.usage.completion_tokens>0);
    const completeness: RunCost["completeness"] = !hasBillableUsage ? "unknown" : unpriced.length ? "partial" : "complete";
    const cost: RunCost | undefined = priced.length || unpriced.length
      ? { currency: "USD", inputUsd: priced.reduce((s,e)=>s+e.inputUsd,0), outputUsd: priced.reduce((s,e)=>s+e.outputUsd,0), totalUsd: priced.reduce((s,e)=>s+e.totalUsd,0), byRole, completeness, priced, unpriced, pricingVersion: this.pricingVersion }
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
    ...(m.cost ? [m.cost.completeness === "complete" ? `Cost (estimated, ${m.cost.pricingVersion}): $${m.cost.totalUsd.toFixed(6)} (input $${m.cost.inputUsd.toFixed(6)}, output $${m.cost.outputUsd.toFixed(6)})` : `Cost (estimated, partial — known subtotal $${m.cost.totalUsd.toFixed(6)}; unpriced: ${m.cost.unpriced.map(u=>`${u.role}/${u.model} ${u.reason}`).join(", ")})`] : []),
    ...(m.responseModels.spark || m.responseModels.wonder ? [`Response models: spark=${m.responseModels.spark ?? "(none reported)"}, wonder=${m.responseModels.wonder ?? "(none reported)"}`] : []),
    `Phases: ${Object.entries(m.phasesMs).map(([phase, duration]) => `${phase}=${ms(duration)}`).join(", ")}, total=${ms(m.totalMs)}`,
    `Prompt hashes: ${m.promptHashes.length ? m.promptHashes.join(", ") : "(none)"}`,
    "",
  );
  return lines.join("\n");
}
