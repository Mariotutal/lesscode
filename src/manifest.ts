import { createHash } from "node:crypto";
import type { ChatMessage } from "./classify/client.js";

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

export interface RunManifest {
  models: { spark: string; wonder: string };
  modelCalls: number;
  /** Per-model call counts (includes Spark's one validation retry when taken). */
  callsByModel: { spark: number; wonder: number };
  usage: TokenUsage;
  /** Wall-clock milliseconds per phase; they sum to totalMs. */
  phasesMs: { resolve: number; prepare: number; classify: number; plan: number; apply: number; gate: number; finalize: number; cleanup: number; overhead: number };
  totalMs: number;
  /** SHA-256 (hex) of each prompt sent, in send order. Hashes only. */
  promptHashes: string[];
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
    return {
      models: { spark: this.sparkModel, wonder: this.wonderModel },
      modelCalls: this.sparkCalls + this.wonderCalls,
      callsByModel: { spark: this.sparkCalls, wonder: this.wonderCalls },
      usage: { ...this.usage },
      phasesMs: { ...this.phasesMs },
      totalMs,
      promptHashes: [...this.promptHashes],
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
    `Phases: ${Object.entries(m.phasesMs).map(([phase, duration]) => `${phase}=${ms(duration)}`).join(", ")}, total=${ms(m.totalMs)}`,
    `Prompt hashes: ${m.promptHashes.length ? m.promptHashes.join(", ") : "(none)"}`,
    "",
  );
  return lines.join("\n");
}
