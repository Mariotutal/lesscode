/**
 * Mechanical convention registry — the catalogue of practices code
 * knows how to fix. A fix is applied only when the repository also
 * lists the practice in its own registry (lesscode-conventions.json,
 * see loadRepositoryConventions below).
 *
 * Most fixes are LessCode text rewrites. Two conventions —
 * semicolons and single-quotes — have no text rewrite at all: when
 * their ESLint rule (`semi` / `quotes`) is enabled by the repository
 * config, the fixer is ESLint itself (eslintFix.ts); that path is
 * still only reachable for a name written in the repository registry.
 *
 * A convention-break finding is kept only when a registered, purely
 * mechanical fix applies to the cited text (and the fix changes it).
 * Any other convention is refused: the model may name the convention,
 * but code decides fixability. `textCheck` is used to decide whether a
 * fix would change anything before producing an edit.
 */
export interface ConventionFix {
  name: string;
  description: string;
  /** true when `fix` would change `text` — pure, no I/O. */
  appliesTo: (text: string) => boolean;
  /** Mechanical rewrite of a single line/segment. Pure. */
  fix: (text: string) => string;
}

export const CONVENTIONS: readonly ConventionFix[] = [
  {
    name: "no-console-log",
    description: "Source files must not contain console.log statements (use a logger/wrapper instead).",
    appliesTo: (t) => /(^|\s)console\.log\(/.test(t),
    fix: (t) => t.replace(/^[ \t]*console\.log\(.*\);\n?/m, ""),
  },
  {
    // semicolons / single-quotes intentionally have no text rewrite:
    // raw text rewrites of quotes or semicolons can change a file in
    // ways the repository never asked for. These entries exist only
    // so the conventions can be named; applyConventionFix applies
    // them through ESLint (`semi` / `quotes`, see eslintFix.ts) when
    // the repository ESLint config enables the rule, and refuses
    // otherwise — unless the registry names them, in which case an
    // ESLint rule is the only mechanism that may produce the edit.
    name: "semicolons",
    description: "Statements end with semicolons (applied via ESLint `semi` when enabled; never a raw text rewrite).",
    appliesTo: () => false,
    fix: (t) => t,
  },
  {
    name: "single-quotes",
    description: "String literals use single quotes (applied via ESLint `quotes` when enabled; never a raw text rewrite).",
    appliesTo: () => false,
    fix: (t) => t,
  },
  {
    name: "import-extension-js",
    description: "Relative imports carry an explicit .js extension (Node16/bundler ESM convention in this codebase).",
    appliesTo: (t) => /from\s+["']\.[^"']*["']/.test(t) && !/from\s+["']\.[^"']*\.(js|ts|mts|cts|json)["']/.test(t),
    fix: (t) => t.replace(/(from\s+["'])(\.[^"']+?)(["'])/g, "$1$2.js$3"),
  },
  {
    name: "no-trailing-whitespace",
    description: "No trailing spaces or tabs at end of lines.",
    appliesTo: (t) => /[ \t]+(?=\n|$)/.test(t),
    fix: (t) => t.replace(/[ \t]+(?=\n|$)/g, ""),
  },
];

export function findConvention(name: string, registeredInRepo?: ReadonlySet<string>): ConventionFix | undefined {
  if (registeredInRepo && !registeredInRepo.has(name)) return undefined;
  return CONVENTIONS.find((c) => c.name === name);
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** File at the checkout root where a repository writes its adopted conventions down. */
export const CONVENTION_REGISTRY_FILE = "lesscode-conventions.json";

/**
 * The repository convention registry: the convention names this
 * repository has written down in `lesscode-conventions.json`
 * (`{"conventions": ["no-console-log", ...]}`). A mechanical fix may
 * be APPLIED only for a name listed here. The same practice, absent
 * from the registry, is refused as an edit and belongs in the review
 * note instead (project description: "A practice is applied only
 * when the repository has it written in the convention registry.").
 */
export function loadRepositoryConventions(checkoutDir: string): string[] {
  const path = join(checkoutDir, CONVENTION_REGISTRY_FILE);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { conventions?: unknown };
    if (!Array.isArray(parsed.conventions)) return [];
    return parsed.conventions.filter((c): c is string => typeof c === "string");
  } catch {
    return [];
  }
}
