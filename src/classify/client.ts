export const META_API_BASE = "https://api.meta.ai/v1";
export const SPARK_MODEL = "muse-spark-1.3";

/**
 * Meta "guest wrapper": the endpoint/key are resolved from the
 * environment so product runs and tests use the same code path.
 *   META_API_BASE_URL  (default https://api.meta.ai/v1)
 *   META_API_KEY | MODEL_API_KEY | META_AI_API_KEY
 */
export interface GuestConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function guestConfig(env: NodeJS.ProcessEnv = process.env): GuestConfig {
  const baseUrl = (env.META_API_BASE_URL ?? META_API_BASE).replace(/\/+$/, "");
  const apiKey = env.META_API_KEY ?? env.MODEL_API_KEY ?? env.META_AI_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "no Meta API key: set META_API_KEY (or MODEL_API_KEY) for the guest wrapper",
    );
  }
  return { baseUrl, apiKey, model: env.META_MODEL ?? SPARK_MODEL };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Minimal dependency injection point so tests can stub the wire. */
export interface GuestClient {
  readonly config: GuestConfig;
  chat(req: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: "auto";
  }): Promise<ChatCompletionResult>;
}

export function createGuestClient(opts?: {
  env?: NodeJS.ProcessEnv;
  fetchFn?: FetchLike;
}): GuestClient {
  const config = guestConfig(opts?.env);
  const fetchFn: FetchLike =
    opts?.fetchFn ??
    (async (url, init) => {
      const res = await fetch(url, init);
      return { ok: res.ok, status: res.status, text: () => res.text() };
    });
  return {
    config,
    async chat(req) {
      const body = {
        model: config.model,
        messages: req.messages,
        ...(req.tools ? { tools: req.tools } : {}),
        // tool_choice stays "auto" — never forced (LES-3).
        ...(req.tools ? { tool_choice: req.toolChoice ?? "auto" } : {}),
      };
      const res = await fetchFn(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`Meta API ${res.status}: ${raw.slice(0, 500)}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Meta API returned non-JSON: ${raw.slice(0, 200)}`);
      }
      const root = parsed as {
        choices?: { message?: ChatMessage; finish_reason?: string }[];
        usage?: ChatCompletionResult["usage"];
        model?: string;
      };
      const choice = root.choices?.[0];
      return {
        content: choice?.message?.content ?? null,
        toolCalls: choice?.message?.tool_calls ?? [],
        finishReason: choice?.finish_reason ?? null,
        usage: root.usage,
        model: root.model,
      };
    },
  };
}

/** True when a guest API key is configured (used by the run guard). */
export function guestEnvAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.META_API_KEY ?? env.MODEL_API_KEY ?? env.META_AI_API_KEY);
}
