/**
 * Back-compat shim: the provider-agnostic client now lives in
 * `src/provider/`. These re-exports keep old imports working.
 * Canonical env: LESSCODE_API_KEY / LESSCODE_API_BASE_URL /
 * LESSCODE_SPARK_MODEL / LESSCODE_WONDER_MODEL (+ per-role keys);
 * META_* / MODEL_API_KEY remain deprecated aliases.
 */
export {
  META_API_BASE,
  SPARK_MODEL,
  DEFAULT_MODEL_TIMEOUT_MS,
  ModelTimeoutError,
  isTransientStatus,
  createGuestClient,
  createModelClient,
  resolveProviderConfig,
  modelEnvAvailable as guestEnvAvailable,
  resolveProviderConfig as guestConfigFor,
} from "../provider/factory.js";
import { createGuestClient, resolveProviderConfig } from "../provider/factory.js";
import type { GuestConfig } from "../provider/types.js";
export type {
  GuestConfig,
  ProviderConfig,
  ChatMessage,
  ToolCall,
  ToolDefinition,
  ChatCompletionResult,
  FetchLike,
  GuestClient,
  ModelClient,
  ModelRole,
} from "../provider/types.js";

/** Legacy resolver (spark role). Prefer resolveProviderConfig(role, env). */
export function guestConfig(env: NodeJS.ProcessEnv = process.env): GuestConfig {
  return resolveProviderConfig("spark", env);
}
export { createGuestClient as createClient };
void createGuestClient;
