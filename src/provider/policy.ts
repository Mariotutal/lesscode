import { z } from "zod";

const trustedProviderSchema = z.object({
  baseUrl: z.string().min(1),
  apiKeyEnv: z.string().min(1),
  allowedModels: z.array(z.string().min(1)).optional(),
}).strict();

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
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 16);
}

export function resolveFromTrustedPolicy(
  role: "spark" | "wonder",
  policy: TrustedPolicy,
  env: NodeJS.ProcessEnv,
): { baseUrl: string; apiKey: string; model: string; provider: string } {
  const ref = policy.models?.[role];
  if (!ref) throw new Error(`trusted policy has no models.${role}`);
  const prov = policy.providers[ref.provider];
  if (!prov) throw new Error(`trusted policy: provider "${ref.provider}" not found`);
  validateUrlSecurity(prov.baseUrl);
  if (prov.allowedModels && !prov.allowedModels.includes(ref.model)) throw new Error(`model "${ref.model}" not allowed for provider "${ref.provider}"`);
  const key = env[prov.apiKeyEnv]?.trim();
  if (!key) throw new Error(`trusted provider "${ref.provider}" missing env ${prov.apiKeyEnv}`);
  return { baseUrl: prov.baseUrl.replace(/\/+$/, ""), apiKey: key, model: ref.model, provider: ref.provider };
}
