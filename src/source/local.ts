import { realpathSync } from "node:fs";
import type { LoadedChange } from "./change.js";
import { diffPaths, resolveCommit } from "./git.js";

/** Local callers declare scope explicitly; uncommitted files are not a revision. */
export async function loadLocalChange(opts: {
  checkout: string;
  base: string;
  intent: string[];
  relatedTests?: string[];
}): Promise<LoadedChange> {
  if (!opts.intent.length) throw new Error("intent is required for a declared local change");
  const checkout = realpathSync(opts.checkout);
  const [headSha, baseSha] = await Promise.all([resolveCommit(checkout, "HEAD"), resolveCommit(checkout, opts.base)]);
  const paths = [...opts.intent];
  return {
    change: {
      checkout, headSha, baseSha, comparisonBaseSha: baseSha,
      changedFiles: await diffPaths(checkout, baseSha, headSha),
      intent: paths, scope: { kind: "declared", paths },
      ...(opts.relatedTests?.length ? { relatedTests: [...opts.relatedTests] } : {}),
    },
    async dispose() { /* The caller owns the local checkout. */ },
  };
}
