import { execFile } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { evaluateGate, type GateCheck } from "../src/gate/gate.js";

const exec = promisify(execFile);

/**
 * Gate mutation cases (LES-27). Take an ACCEPTED patch (a directory
 * whose tree is the post-patch state, diffed against `baseRef`),
 * change one behaviour the visible tests do NOT cover, and ask the
 * full gate which check, if any, catches it.
 *
 * A mutation that no check catches is a stated hole, not a silent
 * pass: `caughtBy` is null and `statement` says so plainly.
 */

export interface Mutation {
  id: string;
  /** The one behaviour change, in words. */
  description: string;
  file: string;
  /** Exact text in the post-patch file that is replaced. */
  from: string;
  to: string;
  /** The single check expected to catch it, or null when no check is expected to (known hole). */
  expectedCheck: string | null;
}

export interface MutationOutcome {
  id: string;
  description: string;
  /** True when the tree-scoped checks (tests/tsc/eslint/test-deletion) all pass on the mutated tree. */
  treeChecksPassed?: boolean;
  /** Names of gate checks that failed on the mutated tree. */
  failedChecks: string[];
  /**
   * For a check that judges the PATCH (size, changed-function
   * complexity): the mutation is not part of any candidate patch,
   * so a failure there is the check reacting to the patch under
   * its feet, not to the mutated behaviour. `caughtBy` therefore
   * counts only checks that judge the mutated TREE: the repo's
   * command checks (tests/tsc/eslint) and tests-not-deleted.
   * Patch checks that fired are reported in `failedChecks` and
   * named in `statement` when they are what stopped the gate.
   */
  caughtBy: string | null;
  /** Plain statement of the outcome, including holes. */
  statement: string;
  gateAccepted: boolean;
}

type MutationBaseline = "accepted" | "head";

export async function runMutation(opts: {
  /** Directory holding the tree to mutate; must be a git repo with `baseRef` available. */
  acceptedDir: string;
  baseRef: string;
  editSet: string[];
  relatedTests: string[];
  mutation: Mutation;
  scratchParent: string;
  /**
   * What the mutation is diffed against (treeAt semantics: the
   * metrics' BEFORE side). "accepted" (default): the gate judges
   * candidate edits against the PR head, so with baseRef at the
   * accepted commit only size/coverage can move — command checks
   * still run against the accepted tree's tests. "head": the
   * cumulative patch-vs-head size check applies as in a live run.
   */
  baseline?: MutationBaseline;
}): Promise<MutationOutcome> {
  const dir = join(opts.scratchParent, opts.mutation.id);
  cpSync(opts.acceptedDir, dir, { recursive: true, filter: (s) => !s.includes("node_modules") });
  if (existsSync(join(opts.acceptedDir, "node_modules"))) {
    await exec("ln", ["-s", join(opts.acceptedDir, "node_modules"), join(dir, "node_modules")]);
  }
  const abs = join(dir, opts.mutation.file);
  const text = readFileSync(abs, "utf8");
  if (!text.includes(opts.mutation.from)) {
    throw new Error(`mutation ${opts.mutation.id}: anchor not found in ${opts.mutation.file}`);
  }
  writeFileSync(abs, text.replace(opts.mutation.from, opts.mutation.to));
  const gate = await evaluateGate({ repoDir: dir, baseRef: opts.baseRef, editSet: opts.editSet, relatedTests: opts.relatedTests });
  const failed = gate.checks.filter((c: GateCheck) => !c.passed).map((c) => c.name);
  // Only checks that RUN THE MUTATED TREE's behaviour count as
  // catching it: the repo's command checks. Size/coverage/export/
  // test-deletion checks diff a candidate patch against its head;
  // here the mutation is an uncommitted working-tree change, so
  // those see the accepted patch (and an uncommitted deletion
  // looks like a test deletion), not the mutated behaviour.
  const TREE_CHECKS = new Set(["related-tests-pass", "tsc-passes", "eslint-touched-passes", "command-timeout"]);
  const treeFailed = failed.filter((n) => TREE_CHECKS.has(n));
  const caughtBy = opts.mutation.expectedCheck
    ? (treeFailed.includes(opts.mutation.expectedCheck) ? opts.mutation.expectedCheck : null)
    : (treeFailed[0] ?? null);
  return {
    id: opts.mutation.id,
    description: opts.mutation.description,
    failedChecks: failed,
    caughtBy,
    gateAccepted: gate.accepted,
    treeChecksPassed: treeFailed.length === 0,
    statement: caughtBy
      ? `caught by ${caughtBy}`
      : `NO CHECK CAUGHT THIS MUTATION — no test, typecheck, or lint check on the mutated tree fails (patch-scoped checks that fired: ${failed.filter((n) => !TREE_CHECKS.has(n)).join(", ") || "none"}; those judge a candidate patch against its head, and there is no candidate patch here)`, 
  };
}

/**
 * The mutation set for the corpus. Anchored on the inline-basic
 * accepted patch: the surviving UserFetcher calls client.get with a
 * template path; the related test covers only `/users/7` for id 7.
 */
export const MUTATIONS: Mutation[] = [
  {
    id: "path-template-change",
    description: "change the request path template from /users/ to /userz/ (the related test uses id 7 and asserts /users/7, so tests DO cover this — a control mutation)",
    file: "src/userFetcher.ts",
    from: "`/users/${id}`",
    to: "`/userz/${id}`",
    expectedCheck: "related-tests-pass",
  },
  {
    id: "error-path-swallow",
    description: "wrap the forwarded call so a rejection resolves to a fake user instead of propagating: no related test exercises a failing client, so no check covers the error path",
    file: "src/userFetcher.ts",
    from: "return this.client.get<User>(`/users/${id}`);",
    to: "return this.client.get<User>(`/users/${id}`).catch(() => ({ id, name: \"fake\", email: \"fake@example.com\" } as User));",
    expectedCheck: null,
  },
];
