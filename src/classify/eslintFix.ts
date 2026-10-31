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
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function eslintBin(checkoutDir: string): string | undefined {
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

const enabledCache = new Map<string, boolean>();

/** True when the repository's ESLint config enables `rule` for `file`. */
export function eslintRuleEnabled(checkoutDir: string, file: string, rule: string): boolean {
  const key = `${checkoutDir}\0${file}\0${rule}`;
  const cached = enabledCache.get(key);
  if (cached !== undefined) return cached;
  let enabled = false;
  const bin = eslintBin(checkoutDir);
  if (bin) {
    try {
      const out = execFileSync(bin, ["--print-config", file], {
        cwd: checkoutDir,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const config = JSON.parse(out) as { rules?: Record<string, unknown> };
      const setting = config.rules?.[rule];
      const severity = Array.isArray(setting) ? setting[0] : setting;
      enabled = severity !== undefined && severity !== 0 && severity !== "off";
    } catch {
      enabled = false;
    }
  }
  enabledCache.set(key, enabled);
  return enabled;
}

/**
 * Run `eslint --fix` on one file. Returns the fixed contents when
 * ESLint changed the file, otherwise undefined. The file on disk is
 * always restored to its original contents before returning.
 */
export function applyEslintFix(checkoutDir: string, file: string): string | undefined {
  const bin = eslintBin(checkoutDir);
  if (!bin) return undefined;
  const abs = join(checkoutDir, file);
  let original: string;
  try {
    original = readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  try {
    execFileSync(bin, ["--fix", file], {
      cwd: checkoutDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
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
