import Anthropic from "@anthropic-ai/sdk";
import type { ChatCompletionResult, ChatMessage, EffortLevel, ModelClient, ModelRole, ProviderConfig, ToolDefinition } from "./types.js";
import { redactSecrets } from "./configFile.js";
import { ANTHROPIC_API_BASE_URL, ModelTimeoutError, isTransientStatus } from "./factory.js";

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaMessage = Anthropic.Beta.BetaMessage;

/** Room for a large Wonder plan; the request streams, so no HTTP timeout is hit. */
export const ANTHROPIC_MAX_OUTPUT_TOKENS = 64_000;
/** Spark classifies; Wonder plans and writes the note. Operators override per role. */
export const DEFAULT_ANTHROPIC_EFFORT: Record<ModelRole, EffortLevel> = { spark: "low", wonder: "high" };
/** Server-side refusal fallback; only the first-party API accepts it. */
export const ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicClientOptions {
  role: ModelRole;
  fetch?: typeof fetch;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  sleep: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/** Translate the internal chat request into a Messages API request body. */
export function encodeAnthropicRequest(config: ProviderConfig, role: ModelRole, request: { messages: ChatMessage[]; tools?: ToolDefinition[] }): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n\n");
  const messages: BetaMessageParam[] = [];
  const push = (role: "user" | "assistant", blocks: BetaContentBlockParam[]) => {
    const last = messages[messages.length - 1];
    if (last?.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of request.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: m.content ?? "" }]);
      continue;
    }
    const blocks: BetaContentBlockParam[] = m.content ? [{ type: "text", text: m.content }] : [];
    if (m.role === "assistant") for (const call of m.tool_calls ?? []) blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || "{}") });
    if (blocks.length) push(m.role, blocks);
  }
  const firstParty = config.baseUrl === ANTHROPIC_API_BASE_URL;
  return {
    model: config.model,
    max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
    ...(system ? { system } : {}),
    messages,
    output_config: { effort: config.effort ?? DEFAULT_ANTHROPIC_EFFORT[role] },
    ...(request.tools?.length ? {
      tools: request.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters as Anthropic.Beta.BetaTool.InputSchema })),
      tool_choice: { type: "auto" as const },
    } : {}),
    ...(firstParty ? { betas: [ANTHROPIC_FALLBACK_BETA], fallbacks: "default" as const } : {}),
  };
}

const FINISH_REASONS: Record<string, string> = { tool_use: "tool_calls", end_turn: "stop", stop_sequence: "stop", max_tokens: "length" };

/** Normalise a Messages API response to the shared completion shape. */
export function decodeAnthropicMessage(message: BetaMessage): ChatCompletionResult {
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category;
    throw new Error(`model API refused the request${category ? ` (${category})` : ""}`);
  }
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const toolCalls = message.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }] : []));
  const u = message.usage;
  const prompt = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return {
    content: text || null,
    toolCalls,
    finishReason: message.stop_reason ? (FINISH_REASONS[message.stop_reason] ?? message.stop_reason) : null,
    usage: { prompt_tokens: prompt, completion_tokens: u.output_tokens, total_tokens: prompt + u.output_tokens },
    model: message.model,
  };
}

/**
 * Anthropic Messages client behind the shared ModelClient seam. Credentials
 * and endpoint come only from the resolved config: the SDK never reads
 * ANTHROPIC_* variables or a local profile. Transport rules match the
 * OpenAI client: no redirects, per-attempt timeout, retry only 429/5xx.
 */
export function createAnthropicClient(config: ProviderConfig, opts: AnthropicClientOptions): ModelClient {
  const baseFetch = opts.fetch ?? fetch;
  const sdk = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    maxRetries: 0,
    timeout: opts.timeoutMs,
    fetch: (url, init) => baseFetch(url, { ...init, redirect: "error" }),
  });
  const safe = (text: string) => redactSecrets(text.split(config.apiKey).join("[redacted]"), opts.env).slice(0, 500);
  return {
    config,
    async chat(req) {
      const body = encodeAnthropicRequest(config, opts.role, req);
      for (let attempt = 0; ; attempt++) {
        req.signal?.throwIfAborted();
        try {
          const message = await sdk.beta.messages.stream(body, { signal: req.signal }).finalMessage();
          return decodeAnthropicMessage(message);
        } catch (e) {
          req.signal?.throwIfAborted();
          if (e instanceof Anthropic.APIConnectionTimeoutError) throw new ModelTimeoutError(opts.timeoutMs);
          if (!(e instanceof Anthropic.APIError) || e.status === undefined) throw e instanceof Error ? new Error(safe(e.message)) : e;
          if (!isTransientStatus(e.status) || attempt >= opts.maxRetries) throw new Error(`model API ${e.status}: ${safe(e.message)}`);
        }
        await opts.sleep(opts.retryBackoffMs * 2 ** attempt);
      }
    },
  };
}
