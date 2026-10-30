/**
 * Mechanical convention registry — the fix half of "convention break:
 * apply a mechanical fix, otherwise refuse" (AGENTS.md closed set).
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
    name: "semicolons",
    description: "Statements end with semicolons.",
    appliesTo: (t) => /\S/.test(t) && !/[;{}:,]\s*$/.test(t.trim()),
    fix: (t) => (/\S/.test(t) && !/[;{}:,]\s*$/.test(t.trim()) ? `${t.replace(/\s+$/, "")};` : t),
  },
  {
    name: "single-quotes",
    description: "String literals use single quotes where the text contains no apostrophe or escapes.",
    appliesTo: (t) => /"[^"'\\\n]*"/.test(t),
    fix: (t) => t.replace(/"([^"'\\\n]*)"/g, "'$1'"),
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

export function findConvention(name: string): ConventionFix | undefined {
  return CONVENTIONS.find((c) => c.name === name);
}
