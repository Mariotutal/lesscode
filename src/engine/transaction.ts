import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normaliseRepoPath, isSealedPath } from "../classify/evidence.js";
import { isTestFile } from "../classify/checkout.js";

export interface FileChange { path: string; before: string | null; after: string | null }
export interface PreparedEdit { findingIndex: number; changes: FileChange[] }
export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");

/** This is the only file-mutation seam used by the review engine. */
export function validateEdit(repo: string, edit: PreparedEdit): void {
  const paths = new Set<string>();
  for (const change of edit.changes) {
    const path = normaliseRepoPath(repo, change.path);
    if (path !== change.path || isSealedPath(path) || isTestFile(path) || /(^|\/)(\.git|node_modules)(\/|$)/.test(path)) throw new Error(`edit may not write ${change.path}`);
    if (paths.has(path)) throw new Error(`duplicate edit path: ${path}`);
    paths.add(path);
    let cursor = repo;
    for (const segment of path.split("/")) {
      cursor = join(cursor, segment);
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`edit may not follow a symlink: ${path}`);
    }
    const current = existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf8") : null;
    if (current !== change.before) throw new Error(`stale edit preimage: ${path}`);
  }
}

function write(repo: string, path: string, text: string | null): void {
  if (text === null) rmSync(join(repo, path), { force: true });
  else { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); }
}

export async function transactEdit<T>(repo: string, edit: PreparedEdit, verify: () => Promise<{ keep: boolean; result: T }>): Promise<{ keep: boolean; result: T }> {
  validateEdit(repo, edit);
  const originalModes = new Map(edit.changes.filter((c) => c.before !== null).map((c) => [c.path, lstatSync(join(repo, c.path)).mode]));
  let committed = false;
  try {
    for (const change of edit.changes) write(repo, change.path, change.after);
    const outcome = await verify();
    committed = outcome.keep;
    return outcome;
  } finally {
    if (!committed) for (const change of edit.changes) {
      write(repo, change.path, change.before);
      const mode = originalModes.get(change.path);
      if (mode !== undefined) chmodSync(join(repo, change.path), mode);
    }
  }
}
