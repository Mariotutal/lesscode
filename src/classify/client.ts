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

/** Every command the gate or this model client starts gets a timeout. */
export const DEFAULT_MODEL_TIMEOUT_MS = 300_000;

/** The model request was stopped by its timeout: the run ends with this reason instead of hanging. */
export class ModelTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`model request timed out after ${timeoutMs}ms`);
    this.name = "ModelTimeoutError";
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Minimal dependency injection point so tests can stub the wire. */
export interface GuestClient {
  readonly config: GuestConfig;
  chat(req: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: "auto";
    signal?: AbortSignal;
  }): Promise<ChatCompletionResult>;
}

/** Transient statuses worth retrying: rate limit and server errors. */
export function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function createGuestClient(opts?: {
  env?: NodeJS.ProcessEnv;
  fetchFn?: FetchLike;
  /** Milliseconds the model request may run before it is aborted; default 300_000. */
  timeoutMs?: number;
  /** Retries after the first attempt for a transient 429/5xx; default 2. */
  maxRetries?: number;
  /** First backoff delay; doubles each retry. Default 500ms. */
  retryBackoffMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}): GuestClient {
  const config = guestConfig(opts?.env);
  const fetchFn: FetchLike =
    opts?.fetchFn ??
    (async (url, init) => {
      const res = await fetch(url, init);
      return { ok: res.ok, status: res.status, text: () => res.text() };
    });
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  const maxRetries = opts?.maxRetries ?? 2;
  const retryBackoffMs = opts?.retryBackoffMs ?? 500;
  const sleep = opts?.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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
      // Timeout (per attempt): a hanging model request is aborted and
      // the run ends with a ModelTimeoutError instead of hanging.
      // Retry: a transient 429/5xx is retried at most maxRetries times
      // with exponential backoff. This is transport retry only — it
      // does not add a Spark validation retry or a second Wonder plan.
      let res: Awaited<ReturnType<FetchLike>> | undefined;
      let raw = "";
      for (let attempt = 0; ; attempt++) {
        req.signal?.throwIfAborted();
        const controller = new AbortController();
        const cancel = () => controller.abort(req.signal?.reason);
        req.signal?.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          res = await fetchFn(`${config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          raw = await res.text();
        } catch (e) {
          req.signal?.throwIfAborted();
          if (controller.signal.aborted) throw new ModelTimeoutError(timeoutMs);
          throw e;
        } finally {
          clearTimeout(timer);
          req.signal?.removeEventListener("abort", cancel);
        }
        if (res.ok) break;
        if (!isTransientStatus(res.status) || attempt >= maxRetries) break;
        await sleep(retryBackoffMs * 2 ** attempt);
      }
      if (!res) throw new Error("Meta API: no response");
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
