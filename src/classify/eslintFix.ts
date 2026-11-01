/**
 * ESLint-backed convention fixes.
 *
 * When a registered convention maps to a rule the repository's own
 * ESLint configuration already enables, the fix belongs to ESLint
 * (`eslint --fix` on the touched file in the scratch worktree), not
 * to a LessCode text rewrite. This module is the synchronous bridge:
 * it resolves an eslint binary (the checkout's own when present,
 * otherwise this package's), asks ESLint for the file's effective
 * config, and runs the fix.
 *
 * `applyEslintFix` never leaves the file mutated: it returns the new
 * contents (or undefined when ESLint changed nothing) and restores
 * the original bytes, so the caller still owns the write.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { trustedLocalExecutor, type RepositoryExecutor } from "../execution/index.js";

/** Convention name -> ESLint rule id that already expresses it. */
export const CONVENTION_ESLINT_RULES: Readonly<Record<string, string>> = {
  "no-console-log": "no-console",
  semicolons: "semi",
  "single-quotes": "quotes",
  "no-trailing-whitespace": "no-trailing-spaces",
};

export function eslintRuleForConvention(name: string): string | undefined {
  return CONVENTION_ESLINT_RULES[name];
}

function eslintBin(checkoutDir: string, executor: RepositoryExecutor): string | undefined {
  if (executor.kind === "docker") return "./node_modules/.bin/eslint";
  let dir = checkoutDir;
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", "eslint");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to this package's own eslint (scratch worktrees of a
  // target repo normally carry/symlink their own node_modules; a bare
  // temp checkout in tests may not).
  const own = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", ".bin", "eslint");
  return existsSync(own) ? own : undefined;
}

/** True when the repository's ESLint config enables `rule` for `file`. */
export function eslintRuleEnabled(checkoutDir: string, file: string, rule: string, executor: RepositoryExecutor = trustedLocalExecutor): boolean {
  let enabled = false;
  const bin = eslintBin(checkoutDir, executor);
  if (bin) {
    try {
      const out = executor.runSync({ repoDir: checkoutDir, command: bin, args: ["--print-config", file] });
      if (out.exitCode !== 0 || out.error) return false;
      const config = JSON.parse(out.stdout) as { rules?: Record<string, unknown> };
      const setting = config.rules?.[rule];
      const severity = Array.isArray(setting) ? setting[0] : setting;
      enabled = severity !== undefined && severity !== 0 && severity !== "off";
    } catch {
      enabled = false;
    }
  }
  return enabled;
}

/**
 * Run `eslint --fix` on one file. Returns the fixed contents when
 * ESLint changed the file, otherwise undefined. The file on disk is
 * always restored to its original contents before returning.
 */
export function applyEslintFix(checkoutDir: string, file: string, executor: RepositoryExecutor = trustedLocalExecutor): string | undefined {
  const bin = eslintBin(checkoutDir, executor);
  if (!bin) return undefined;
  const abs = join(checkoutDir, file);
  let original: string;
  try {
    original = readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  try {
    const result = executor.runSync({ repoDir: checkoutDir, command: bin, args: ["--fix", file] });
    if (result.timedOut || result.error) { writeFileSync(abs, original); return undefined; }
  } catch {
    // --fix exits non-zero when unfixable problems remain; the file
    // may still have been rewritten, so fall through and compare.
  }
  let fixed: string;
  try {
    fixed = readFileSync(abs, "utf8");
  } catch {
    return undefined;
  } finally {
    try {
      writeFileSync(abs, original);
    } catch {
      // best effort: caller rewrites from the returned contents anyway
    }
  }
  return fixed !== original ? fixed : undefined;
}

/** Core runs are asynchronous so executable repository config cannot block the hosted API. */
export async function eslintRuleEnabledAsync(checkoutDir: string, file: string, rule: string, executor: RepositoryExecutor = trustedLocalExecutor): Promise<boolean> {
  const bin = eslintBin(checkoutDir, executor);
  if (!bin) return false;
  const result = await executor.run({ repoDir: checkoutDir, command: bin, args: ["--print-config", file] });
  if (result.exitCode !== 0 || result.error) return false;
  try {
    const config = JSON.parse(result.stdout) as { rules?: Record<string, unknown> };
    const setting = config.rules?.[rule];
    const severity = Array.isArray(setting) ? setting[0] : setting;
    return severity !== undefined && severity !== 0 && severity !== "off";
  } catch { return false; }
}

/** ESLint returns proposed bytes as JSON; the transaction remains the only writer. */
export async function applyEslintFixAsync(checkoutDir: string, file: string, executor: RepositoryExecutor = trustedLocalExecutor): Promise<string | undefined> {
  const bin = eslintBin(checkoutDir, executor);
  if (!bin) return undefined;
  const result = await executor.run({ repoDir: checkoutDir, command: bin, args: ["--fix-dry-run", "--format", "json", file] });
  if (result.error || result.timedOut) return undefined;
  try {
    const results = JSON.parse(result.stdout) as { output?: string }[];
    const output = results.length === 1 ? results[0]?.output : undefined;
    return output !== undefined && output !== readFileSync(join(checkoutDir, file), "utf8") ? output : undefined;
  } catch { return undefined; }
}
