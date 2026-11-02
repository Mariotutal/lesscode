import type { FetchLike, ModelClient, ModelRole, ProviderConfig } from "./types.js";

export const DEFAULT_API_BASE_URL = "https://api.meta.ai/v1";
export const META_API_BASE = DEFAULT_API_BASE_URL;
export const SPARK_MODEL = "muse-spark-1.3";
export const WONDER_MODEL = "muse-wonder-1.0";
export const DEFAULT_MODELS: Record<ModelRole, string> = { spark: SPARK_MODEL, wonder: WONDER_MODEL };

/** Every command the gate or this model client starts gets a timeout. */
export const DEFAULT_MODEL_TIMEOUT_MS = 300_000;

export class ModelTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`model request timed out after ${timeoutMs}ms`);
    this.name = "ModelTimeoutError";
  }
}

/**
 * Provider-agnostic env resolution.
 * Canonical: LESSCODE_API_BASE_URL, LESSCODE_API_KEY,
 *   LESSCODE_SPARK_API_KEY / LESSCODE_WONDER_API_KEY (per-role key override),
 *   LESSCODE_SPARK_MODEL / LESSCODE_WONDER_MODEL (per-role), LESSCODE_MODEL.
 * Deprecated aliases (warn once per name): META_API_BASE_URL, META_MODEL,
 *   META_API_KEY | MODEL_API_KEY | META_AI_API_KEY.
 * Per-role LESSCODE_* beats shared LESSCODE_*, which beats META_*, which beats defaults.
 * Empty/blank values are treated as unset.
 */
const warned = new Set<string>();
export function warnDeprecatedAlias(name: string, warn: (msg: string) => void = (m) => console.warn(m)): void {
  if (warned.has(name)) return;
  warned.add(name);
  warn(`[lesscode] ${name} is deprecated; use the corresponding LESSCODE_* variable`);
}
/** Test hook: reset the once-per-name deprecation warning latch. */
export function resetDeprecationWarnings(): void { warned.clear(); }

function pick(env: NodeJS.ProcessEnv, names: string[], warn?: (msg: string) => void): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      if (name.startsWith("META_") || name === "MODEL_API_KEY") warnDeprecatedAlias(name, warn);
      return value;
    }
  }
  return undefined;
}

export function resolveProviderConfig(
  role: ModelRole = "spark",
  env: NodeJS.ProcessEnv = process.env,
  opts?: { warn?: (msg: string) => void },
): ProviderConfig {
  const warn = opts?.warn;
  const roleUpper = role.toUpperCase() as "SPARK" | "WONDER";
  const baseUrlRaw =
    pick(env, ["LESSCODE_API_BASE_URL", `LESSCODE_${roleUpper}_API_BASE_URL`, "META_API_BASE_URL"], warn) ??
    DEFAULT_API_BASE_URL;
  const apiKey =
    pick(env, [`LESSCODE_${roleUpper}_API_KEY`, "LESSCODE_API_KEY", "META_API_KEY", "MODEL_API_KEY", "META_AI_API_KEY"], warn) ?? "";
  if (!apiKey) {
    throw new Error(
      "no model API key: set LESSCODE_API_KEY (or the deprecated META_API_KEY) for the model provider",
    );
  }
  const model =
    pick(env, [`LESSCODE_${roleUpper}_MODEL`, "LESSCODE_MODEL", "META_MODEL"], warn) ?? DEFAULT_MODELS[role];
  const provider = pick(env, ["LESSCODE_PROVIDER"], warn);
  return {
    baseUrl: baseUrlRaw.replace(/\/+$/, ""),
    apiKey,
    model,
    ...(provider ? { provider } : {}),
  };
}

/** True when a model API key is configured (used by the run guard). */
export function modelEnvAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.LESSCODE_SPARK_API_KEY?.trim() || env.LESSCODE_WONDER_API_KEY?.trim() || env.LESSCODE_API_KEY?.trim() ||
    env.META_API_KEY?.trim() || env.MODEL_API_KEY?.trim() || env.META_AI_API_KEY?.trim(),
  );
}

/** Transient statuses worth retrying: rate limit and server errors. */
export function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export interface CreateModelClientOptions {
  env?: NodeJS.ProcessEnv;
  config?: ProviderConfig;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  warn?: (msg: string) => void;
}

export function createModelClient(role: ModelRole = "spark", opts?: CreateModelClientOptions): ModelClient {
  const config = opts?.config ?? resolveProviderConfig(role, opts?.env, { warn: opts?.warn });
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
      // Timeout (per attempt) + transport retry on transient 429/5xx
      // (at most maxRetries, exponential backoff). No extra model calls.
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
      // Keep historic "Meta API" wording only when talking to the default Meta endpoint.
      const label = config.baseUrl === DEFAULT_API_BASE_URL ? "Meta API" : "model API";
      if (!res) throw new Error(`${label}: no response`);
      if (!res.ok) throw new Error(`${label} ${res.status}: ${raw.slice(0, 500)}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`${label} returned non-JSON: ${raw.slice(0, 200)}`);
      }
      const root = parsed as {
        choices?: { message?: import("./types.js").ChatMessage; finish_reason?: string }[];
        usage?: ChatCompletionResultUsage;
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

type ChatCompletionResultUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

/** Back-compat: default role is spark. */
export function createGuestClient(opts?: CreateModelClientOptions & { role?: ModelRole }): ModelClient {
  return createModelClient(opts?.role ?? "spark", opts);
}
