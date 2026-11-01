import { existsSync, readFileSync, lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Citation, Finding } from "./schema.js";
// Finding is the model-side type; scope-creep findings (code-decided)
// are a separate type in scopeCreep.ts and share the citation shape.

/** Normalise a repo-relative path (POSIX separators), or undefined if it escapes. */
export function normaliseRepoPath(checkoutDir: string, file: string): string | undefined {
  if (isAbsolute(file)) return undefined;
  const cleaned = file.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!cleaned || cleaned.includes("\0")) return undefined;
  const abs = resolve(checkoutDir, cleaned);
  const rel = relative(resolve(checkoutDir), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  let cursor = resolve(checkoutDir);
  for (const segment of rel.split(sep)) {
    cursor = resolve(cursor, segment);
    try { if (lstatSync(cursor).isSymbolicLink()) return undefined; } catch { /* absent paths can still be restoration targets */ }
  }
  return rel.split(sep).join("/");
}

/** True when the path is, or lives under, a fixtures/<n>/sealed/ directory. */
export function isSealedPath(file: string): boolean {
  return /(^|\/)fixtures\/[^/]+\/sealed(\/|$)/.test(file) || /(^|\/)sealed(\/|$)/.test(file);
}

function fileLines(checkoutDir: string, repoPath: string): string[] | undefined {
  const abs = resolve(checkoutDir, repoPath);
  if (!existsSync(abs)) return undefined;
  return readFileSync(abs, "utf8").split("\n");
}

/** Lines of a citation's file as read from an in-memory text (e.g. `git show <base>:<file>`), or false when the range is outside it. Sealed paths never exist. */
export function citationExistsInText(c: Citation, text: string): boolean {
  if (isSealedPath(c.file.replace(/\\/g, "/"))) return false;
  const lines = text.split("\n");
  const lastLine = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  return c.startLine >= 1 && c.endLine >= c.startLine && c.endLine <= lastLine;
}

export function citationExists(checkoutDir: string, c: Citation): boolean {
  const repoPath = normaliseRepoPath(checkoutDir, c.file);
  if (repoPath === undefined || isSealedPath(repoPath)) return false;
  const lines = fileLines(checkoutDir, repoPath);
  if (!lines) return false;
  // A trailing "\n" makes split() yield a final empty pseudo-line; a real
  // last line still counts, but nothing beyond the file's last line.
  return citationExistsInText(c, lines.join("\n"));
}

/**
 * Evidence filter: drop any finding that does not cite lines that exist
 * in the checkout. A finding survives only when its `file` is a real
 * in-checkout file AND every citation points at existing lines of an
 * in-checkout (non-sealed) file. Findings about sealed fixtures are
 * dropped here — the classifier itself never reads them.
 */
export function filterByEvidence<T extends Finding>(checkoutDir: string, findings: readonly T[]): T[] {
  return findings.filter((f) => {
    const fPath = normaliseRepoPath(checkoutDir, f.file);
    if (fPath === undefined || isSealedPath(fPath)) return false;
    if (fileLines(checkoutDir, fPath) === undefined) return false;
    return f.citations.length > 0 && f.citations.every((c) => citationExists(checkoutDir, c));
  });
}
