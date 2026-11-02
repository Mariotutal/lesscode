import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { z } from "zod";

/**
 * Committable per-repo config: `.lesscode.json` (Continue shape).
 *
 * This file is meant to be committed, so it must never hold a secret:
 * providers name the environment variable that holds the key
 * (`apiKeyEnv`), never the key itself (`apiKey` is rejected). Config
 * errors are public-safe: messages name the file, field and env-var
 * NAME only — never an env value or any file content beyond the
 * offending field name.
 */
export const CONFIG_FILE_NAME = ".lesscode.json";
/** Stable $schema URL served/documented with the shipped schema (schemas/lesscode.schema.json). */
export const LESSCODE_CONFIG_SCHEMA_URL = "https://lesscode.dev/schemas/lesscode.schema.json";

const providerEntrySchema = z
  .object({
    baseUrl: z.string().min(1),
    apiKeyEnv: z.string().min(1),
    // Commit-safety: a literal key in a committed file is a leak, not config.
    apiKey: z.never().optional(),
  })
  .strict();
const modelRefSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict();
const pricingEntrySchema = z.object({ inputPerMtok: z.number().nonnegative().optional(), outputPerMtok: z.number().nonnegative().optional() }).strict();

export const lesscodeConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    providers: z.record(z.string().min(1), providerEntrySchema).optional(),
    models: z.object({ spark: modelRefSchema.optional(), wonder: modelRefSchema.optional() }).strict().optional(),
    pricing: z.record(z.string().min(1), pricingEntrySchema).optional(),
  })
  .strict();

export type LesscodeConfig = z.infer<typeof lesscodeConfigSchema>;
export type LesscodeProviderEntry = z.infer<typeof providerEntrySchema>;
export type LesscodePricing = NonNullable<LesscodeConfig["pricing"]>;

export interface LoadedLesscodeConfig {
  /** Absolute path of the config file found, or null when no file applies. */
  path: string | null;
  config: LesscodeConfig | null;
}

/** Drop secrets / credential-looking values before a config reaches logs or errors. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 4 && /(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) out = out.split(value).join("[redacted]");
  }
  return out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]").replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,})\b/g, "[redacted]");
}

function isSealedPath(p: string): boolean {
  return p.split(/[\\/]/).includes("sealed");
}

function safeIssue(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`).join("; ");
}

/**
 * Search `startDir` and its ancestors (up to the filesystem root) for
 * `.lesscode.json`, following the `lesscode-conventions.json` precedent:
 * a per-repo file found by walking to the repo root. The walk never
 * descends into a `sealed/` directory and never reads one inside it.
 */
export function findLesscodeConfigPath(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (!isSealedPath(dir)) {
      const candidate = join(dir, CONFIG_FILE_NAME);
      if (existsSync(candidate)) {
        // Resolve symlinks so a link into a sealed tree is still refused.
        let real = candidate;
        try { real = realpathSync(candidate); } catch { /* keep lexical path */ }
        if (!isSealedPath(real)) return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir || parent === parse(dir).root) return null;
    dir = parent;
  }
}

const cache = new Map<string, LoadedLesscodeConfig>();
/** Test/ops hook: drop memoized config loads (e.g. after writing a new file). */
export function clearLesscodeConfigCache(): void { cache.clear(); }

/**
 * Load and zod-validate `.lesscode.json` for `startDir` (cached per
 * resolved start dir). Missing file is not an error ({path:null}).
 * Malformed JSON / schema violations throw a secret-free error.
 */
export function loadLesscodeConfig(startDir: string, opts?: { noCache?: boolean }): LoadedLesscodeConfig {
  const key = startDir;
  if (!opts?.noCache) { const hit = cache.get(key); if (hit) return hit; }
  const path = findLesscodeConfigPath(startDir);
  let loaded: LoadedLesscodeConfig = { path, config: null };
  if (path) {
    if (!statSync(path).isFile()) throw new Error(`${CONFIG_FILE_NAME} at ${path} is not a file`);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error(`${CONFIG_FILE_NAME} at ${path} is not valid JSON`); }
    const parsed = lesscodeConfigSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`${CONFIG_FILE_NAME} at ${path} is invalid: ${redactSecrets(safeIssue(parsed.error))}`);
    // Defence in depth: zod already rejects `apiKey` (z.never), but never
    // let a credential-shaped key slip through a future schema change.
    for (const [name, p] of Object.entries(parsed.data.providers ?? {})) {
      if ((p as Record<string, unknown>).apiKey) throw new Error(`${CONFIG_FILE_NAME}: providers.${name}.apiKey must not be stored in a committed file; use apiKeyEnv`);
      try { new URL(p.baseUrl); } catch { throw new Error(`${CONFIG_FILE_NAME}: providers.${name}.baseUrl is not a valid URL`); }
    }
    loaded = { path, config: parsed.data };
  }
  if (!opts?.noCache) cache.set(key, loaded);
  return loaded;
}
