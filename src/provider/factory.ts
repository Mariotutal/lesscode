import type { FetchLike, ModelClient, ModelRole, ProviderConfig } from "./types.js";
import { loadLesscodeConfig, redactSecrets, type LesscodeConfig } from "./configFile.js";
import { loadTrustedPolicy, resolveFromTrustedPolicy, type TrustedPolicy } from "./policy.js";
import { openAiChatProtocol, type ModelProtocol } from './protocol.js';

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

export interface ResolveProviderOptions {
  warn?: (msg: string) => void;
  /** Repo root to search for `.lesscode.json` — only use with trusted checkouts. */
  cwd?: string;
  /** When true, cwd is treated as trusted (operator-owned). Fetched PR checkouts must not set this. */
  trusted?: boolean;
  /** Operator-owned trusted policy; when present file `providers` are ignored and aliases must exist in it. */
  trustedPolicy?: TrustedPolicy | null;
  /** Explicit config; beats env candidate which beats file. Null disables file layer. */
  explicit?: Partial<ProviderConfig> & { provider?: string };
  /** Pre-loaded file config (mainly tests); `cwd` search is skipped. */
  fileConfig?: LesscodeConfig | null;
}

/**
 * Resolution: explicit arg > LESSCODE_* env (incl. deprecated META_*)
 * > operator trusted policy > `.lesscode.json` file > hardcoded defaults.
 * File `providers` (baseUrl + apiKeyEnv) apply only when `trusted` is true
 * (operator-owned cwd). Untrusted checkouts may request an alias+model
 * when a trusted policy is present; they cannot choose endpoint or credential env.
 * Env always overrides the file. Secrets only via env indirection.
 */
export function resolveProviderConfig(
  role: ModelRole = "spark",
  env: NodeJS.ProcessEnv = process.env,
  opts?: ResolveProviderOptions,
): ProviderConfig {
  const warn = opts?.warn;
  const roleUpper = role.toUpperCase() as "SPARK" | "WONDER";
  if (opts?.explicit?.baseUrl && opts?.explicit?.apiKey) {
    return {
      baseUrl: opts.explicit.baseUrl.replace(/\/+$/, ""),
      apiKey: opts.explicit.apiKey,
      model: opts.explicit.model ?? pick(env, [`LESSCODE_${roleUpper}_MODEL`, "LESSCODE_MODEL", "META_MODEL"], warn) ?? DEFAULT_MODELS[role],
      ...(opts.explicit.provider ? { provider: opts.explicit.provider } : {}),
    };
  }
  const trustedPolicy = opts?.trustedPolicy !== undefined ? opts.trustedPolicy : loadTrustedPolicy(env);
  const trusted = opts?.trusted === true;
  const file: LesscodeConfig | null = opts && "fileConfig" in opts ? (opts.fileConfig ?? null)
    : opts?.cwd && (trusted || trustedPolicy) ? loadLesscodeConfig(opts.cwd).config : null;
  // Policy path: checkout may only request alias+model, never endpoint/credential.
  if (trustedPolicy) {
    const fileRef = file?.models?.[role];
    if (fileRef) {
      const policyProvider = trustedPolicy.providers[fileRef.provider];
      if (!policyProvider) throw new Error(`.lesscode.json: models.${role}.provider "${fileRef.provider}" is not in trusted policy`);
      if (policyProvider.allowedModels && !policyProvider.allowedModels.includes(fileRef.model)) throw new Error(`model "${fileRef.model}" not allowed for provider "${fileRef.provider}"`);
      const apiKey = env[policyProvider.apiKeyEnv]?.trim();
      if (!apiKey) throw new Error(`trusted provider "${fileRef.provider}" missing env ${policyProvider.apiKeyEnv}`);
      return {
        baseUrl: policyProvider.baseUrl.replace(/\/+$/, ""),
        apiKey,
        model: fileRef.model,
        provider: fileRef.provider,
        ...(trusted && file?.pricing ? { pricing: file.pricing } : {}),
      };
    }
    if (trustedPolicy.models?.[role]) return resolveFromTrustedPolicy(role, trustedPolicy, env);
  }
  const useFileProviders = trusted;
  const ref = useFileProviders ? file?.models?.[role] : undefined;
  const named = ref ? file?.providers?.[ref.provider] : undefined;
  if (ref && !named) throw new Error(`.lesscode.json: models.${role}.provider "${ref.provider}" is not defined in providers`);
  const fileKey = named ? env[named.apiKeyEnv]?.trim() : undefined;
  // Canonical LESSCODE_* beats the file; the file's provider-specific
  // key indirection beats the deprecated global META_*/MODEL_* aliases.
  // Otherwise an unrelated legacy key for the *other* provider would
  // silently hijack a provider pinned by the committed file.
  const baseUrlRaw =
    opts?.explicit?.baseUrl ??
    pick(env, [`LESSCODE_${roleUpper}_API_BASE_URL`, "LESSCODE_API_BASE_URL"], warn) ??
    named?.baseUrl ??
    pick(env, ["META_API_BASE_URL"], warn) ?? DEFAULT_API_BASE_URL;
  const apiKey =
    opts?.explicit?.apiKey ??
    pick(env, [`LESSCODE_${roleUpper}_API_KEY`, "LESSCODE_API_KEY"], warn) ??
    (fileKey || undefined) ??
    pick(env, ["META_API_KEY", "MODEL_API_KEY", "META_AI_API_KEY"], warn) ?? "";
  if (!apiKey) {
    throw new Error(named
      ? `no model API key: .lesscode.json provider "${ref!.provider}" names env var ${named.apiKeyEnv}, which is unset (or set LESSCODE_API_KEY)`
      : "no model API key: set LESSCODE_API_KEY (or the deprecated META_API_KEY) for the model provider");
  }
  const model =
    opts?.explicit?.model ??
    pick(env, [`LESSCODE_${roleUpper}_MODEL`, "LESSCODE_MODEL", "META_MODEL"], warn) ?? ref?.model ?? DEFAULT_MODELS[role];
  const provider = opts?.explicit?.provider ?? pick(env, ["LESSCODE_PROVIDER"], warn) ?? ref?.provider;
  return {
    baseUrl: baseUrlRaw.replace(/\/+$/, ""),
    apiKey,
    model,
    ...(provider ? { provider } : {}),
    ...(file?.pricing ? { pricing: file.pricing } : {}),
  };
}

/** True when a model API key is configured (used by the run guard). Untrusted cwd is never scanned. */
export function modelEnvAvailable(env: NodeJS.ProcessEnv = process.env, cwd?: string, trusted = false): boolean {
  if (env.LESSCODE_SPARK_API_KEY?.trim() || env.LESSCODE_WONDER_API_KEY?.trim() || env.LESSCODE_API_KEY?.trim() ||
    env.META_API_KEY?.trim() || env.MODEL_API_KEY?.trim() || env.META_AI_API_KEY?.trim()) return true;
  if (!cwd || !trusted) return false;
  try {
    const { config } = loadLesscodeConfig(cwd);
    return Object.values(config?.providers ?? {}).some((p) => env[p.apiKeyEnv]?.trim());
  } catch { return false; }
}

/** Transient statuses worth retrying: rate limit and server errors. */
export function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export interface CreateModelClientOptions {
  protocol?: ModelProtocol;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  trusted?: boolean;
  trustedPolicy?: TrustedPolicy | null;
  fileConfig?: LesscodeConfig | null;
  config?: ProviderConfig;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  warn?: (msg: string) => void;
}

export function createModelClient(role: ModelRole = "spark", opts?: CreateModelClientOptions): ModelClient {
  const config = opts?.config ?? resolveProviderConfig(role, opts?.env, { warn: opts?.warn, trustedPolicy: opts?.trustedPolicy, ...(opts && "fileConfig" in opts ? { fileConfig: opts.fileConfig } : {}), ...(opts?.cwd ? { cwd: opts.cwd, trusted: opts.trusted === true } : {}) });
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
  const protocol = opts?.protocol ?? openAiChatProtocol;
  return {
    config,
    async chat(req) {
      if (req.tools?.length && !protocol.supportsTools) throw new Error(`model protocol ${protocol.id} does not support tools`);
      const encoded = protocol.encode(config, req);
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
          res = await fetchFn(encoded.url, {
            redirect: "error",
            method: "POST",
            headers: encoded.headers,
            body: JSON.stringify(encoded.body),
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
      const safeResponse = (text: string) => redactSecrets(text.split(config.apiKey).join('[redacted]'), opts?.env).slice(0, 500);
      if (!res.ok) throw new Error(`${label} ${res.status}: ${safeResponse(raw)}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`${label} returned non-JSON: ${safeResponse(raw)}`);
      }
      return protocol.decode(parsed);
    },
  };
}


/** Back-compat: default role is spark. */
export function createGuestClient(opts?: CreateModelClientOptions & { role?: ModelRole }): ModelClient {
  return createModelClient(opts?.role ?? "spark", opts);
}
