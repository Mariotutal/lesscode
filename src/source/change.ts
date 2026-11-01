import { isSealedPath } from "../classify/evidence.js";
import { isNonBehaviourPath, isSourceFile } from "../classify/checkout.js";

export interface ChangeScope {
  kind: "declared" | "inferred";
  paths: string[];
}

/** All identities are commit SHAs. The comparison base is the merge base for a PR. */
export interface ResolvedChange {
  checkout: string;
  baseSha: string;
  headSha: string;
  comparisonBaseSha: string;
  changedFiles: string[];
  intent: string[];
  scope: ChangeScope;
  relatedTests?: string[];
}

export interface PullRequestIdentity {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  remoteUrl: string;
}

/** The caller keeps this handle alive through verification and publication. */
export interface LoadedChange {
  change: ResolvedChange;
  pullRequest?: PullRequestIdentity;
  dispose(): Promise<void>;
}

/** Inferred scope is visibility, not proof of what the author intended. */
export function deriveIntent(changedFiles: readonly string[]): string[] {
  return [...new Set(changedFiles)].filter((file) =>
    !isSealedPath(file) && !isNonBehaviourPath(file) && (isSourceFile(file) || /\.(?:d\.[cm]?ts|svelte|vue)$/.test(file)),
  ).sort();
}
