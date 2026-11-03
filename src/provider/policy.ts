import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { PROTOCOL_IDS, type ProtocolId } from "./types.js";

const trustedProviderSchema = z
  .object({
    baseUrl: z.string().min(1).refine((v) => {
      try {
        validateUrlSecurity(v);
        return true;
      } catch {
        return false;
      }
    }, "must be https without credentials"),
    apiKeyEnv: z.string().min(1),
    protocol: z.enum(PROTOCOL_IDS).optional(),
    allowedModels: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const trustedPolicySchema = z.object({
  version: z.literal(1),
  providers: z.record(z.string().min(1), trustedProviderSchema),
  models: z.object({ spark: z.object({ provider: z.string().min(1), model: z.string().min(1) }).optional(), wonder: z.object({ provider: z.string().min(1), model: z.string().min(1) }).optional() }).optional(),
}).strict();

export type TrustedPolicy = z.infer<typeof trustedPolicySchema>;
export type TrustedProvider = z.infer<typeof trustedProviderSchema>;

export function validateUrlSecurity(baseUrl: string): void {
  const u = new URL(baseUrl);
  if (u.protocol !== "https:") throw new Error(`provider baseUrl must use https: ${baseUrl}`);
  if (u.username || u.password) throw new Error(`provider baseUrl must not contain credentials: ${baseUrl}`);
}

export function hashPolicy(policy: TrustedPolicy): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(policy))).digest("hex");
}

/** Backwards-compatible no-op; policy snapshots are owned by each run. */
export function clearTrustedPolicyCache(): void { }

export function loadTrustedPolicy(env: NodeJS.ProcessEnv = process.env, _opts?: { noCache?: boolean }): TrustedPolicy | null {
  void _opts;
  const raw = env.LESSCODE_TRUSTED_POLICY?.trim() || env.LESSCODE_TRUSTED_POLICY_FILE?.trim();
  let policy: TrustedPolicy | null = null;
  if (raw) {
    let json: unknown;
    if (raw.startsWith("{")) {
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error("LESSCODE_TRUSTED_POLICY is not valid JSON");
      }
    } else {
      if (!existsSync(raw)) throw new Error(`LESSCODE_TRUSTED_POLICY_FILE not found: ${raw}`);
      try {
        json = JSON.parse(readFileSync(raw, "utf8"));
      } catch {
        throw new Error(`LESSCODE_TRUSTED_POLICY_FILE is not valid JSON: ${raw}`);
      }
    }
    const parsed = trustedPolicySchema.safeParse(json);
    if (!parsed.success) throw new Error(`trusted policy invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`).join("; ")}`);
    policy = parsed.data;
    for (const [name, prov] of Object.entries(policy.providers)) {
      validateUrlSecurity(prov.baseUrl);
      if (prov.allowedModels && prov.allowedModels.length === 0) throw new Error(`provider ${name}: allowedModels must be non-empty if set`);
    }
  }
  return policy;
}

export function resolveFromTrustedPolicy(
  role: "spark" | "wonder",
  policy: TrustedPolicy,
  env: NodeJS.ProcessEnv,
): { baseUrl: string; apiKey: string; model: string; provider: string; protocol?: ProtocolId } {
  const ref = policy.models?.[role];
  if (!ref) throw new Error(`trusted policy has no models.${role}`);
  const prov = policy.providers[ref.provider];
  if (!prov) throw new Error(`trusted policy: provider "${ref.provider}" not found`);
  validateUrlSecurity(prov.baseUrl);
  if (prov.allowedModels && !prov.allowedModels.includes(ref.model)) throw new Error(`model "${ref.model}" not allowed for provider "${ref.provider}"`);
  const key = env[prov.apiKeyEnv]?.trim();
  if (!key) throw new Error(`trusted provider "${ref.provider}" missing env ${prov.apiKeyEnv}`);
  return { baseUrl: prov.baseUrl.replace(/\/+$/, ""), apiKey: key, model: ref.model, provider: ref.provider, ...(prov.protocol ? { protocol: prov.protocol } : {}) };
}
