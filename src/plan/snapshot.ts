import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The one snapshot/restore implementation (LES-29): capture the
 * current contents (or absence) of a set of repo-relative files so a
 * rejected edit can be rolled back exactly — restored files get their
 * parent directories recreated, files that did not exist are removed.
 */
export interface Snapshot {
  file: string;
  content: string | null;
}

export function snapshotFiles(repo: string, files: readonly string[]): Snapshot[] {
  return files.map((file) => ({
    file,
    content: existsSync(join(repo, file)) ? readFileSync(join(repo, file), "utf8") : null,
  }));
}

export function restoreFiles(repo: string, snaps: readonly Snapshot[]): void {
  for (const s of snaps) {
    if (s.content === null) rmSync(join(repo, s.file), { force: true });
    else {
      mkdirSync(dirname(join(repo, s.file)), { recursive: true });
      writeFileSync(join(repo, s.file), s.content);
    }
  }
}
