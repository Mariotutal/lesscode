/**
 * One argument parser for every command adapter (gate, classify,
 * plan, simplify, review, simplify-tool, pr-review, github-pr-review).
 *
 * Shape: `--name value`, `--name=value`, `--flag`, comma lists via
 * kind:"list". `--help`/`-h` is always available and each command
 * supplies its own help text. Unknown/missing-value arguments are
 * errors, never silently ignored.
 *
 * Exit codes (the scheme simplify already used, now everywhere a
 * verdict exists): 0 accepted, 1 refused or reviewed, 2 run failure.
 * Help and argument errors: help exits 0, argument errors exit 2.
 */
export class ArgError extends Error {}

export interface ArgSpec {
  name: string;
  kind: "value" | "list" | "flag";
  required?: boolean;
}

export interface ParsedArgs {
  help: boolean;
  values: Map<string, string>;
  lists: Map<string, string[]>;
  flags: Set<string>;
}

export function parseArgs(argv: string[], specs: ArgSpec[], usage: string): ParsedArgs {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const out: ParsedArgs = { help: false, values: new Map(), lists: new Map(), flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "--help" || raw === "-h") { out.help = true; continue; }
    if (!raw.startsWith("--")) throw new ArgError(`unexpected argument: ${raw}\n${usage}`);
    const eq = raw.indexOf("=");
    const name = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const spec = byName.get(name);
    if (!spec) throw new ArgError(`unknown argument: --${name}\n${usage}`);
    if (spec.kind === "flag") { out.flags.add(name); continue; }
    const value = eq >= 0 ? raw.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith("--")) throw new ArgError(`missing value for --${name}\n${usage}`);
    if (spec.kind === "list") {
      const items = value.split(",").map((s) => s.trim()).filter(Boolean);
      out.lists.set(name, [...(out.lists.get(name) ?? []), ...items]);
    } else out.values.set(name, value);
  }
  if (!out.help) {
    for (const s of specs) if (s.required && !out.values.has(s.name) && !out.lists.has(s.name)) {
      throw new ArgError(`missing --${s.name}\n${usage}`);
    }
  }
  return out;
}

/** 0 accepted, 1 refused/reviewed, 2 failed run. */
export function exitCodeForVerdict(verdict: string): number {
  return verdict === "accepted" ? 0 : verdict === "failed" ? 2 : 1;
}

/** Shared CLI tail: --help prints usage (0); ArgError prints to stderr (2). Returns true when handled. */
export function handleHelpOrError(args: ParsedArgs | ArgError, usage: string): boolean {
  if (args instanceof ArgError) { console.error(args.message); process.exit(2); }
  if (args.help) { console.log(usage); process.exit(0); }
  return false;
}

export function tryParse(argv: string[], specs: ArgSpec[], usage: string): ParsedArgs {
  try { return parseArgs(argv, specs, usage); }
  catch (e) { if (e instanceof ArgError) { handleHelpOrError(e, usage); } throw e; }
}
