import { readFileSync } from "node:fs";
import { join } from "node:path";
import { review, type ReviewOptions, type ReviewResult } from "../review/index.js";
import { PR_DECLARATION_FILE, prDeclarationSchema, type PrDeclaration, type PrReviewCheck, type PrReviewComment, type PrReviewPost } from "./schema.js";

/**
 * The pull-request caller of review(checkout, base, intent).
 *
 * No second pipeline: this file resolves { checkout, base, intent }
 * from the files the pull request declares, calls `review` once, and
 * splits its result into the two posts the task requires:
 *
 *   - the GATE is posted as a check (`check.body` is exactly
 *     JSON.stringify(result.gate); the conclusion derives from the
 *     gate alone, so a failing gate can be a required check);
 *   - the SENIOR NOTE is posted as a comment (`comment.body` is
 *     exactly result.review.markdown; it is not applied and cannot
 *     satisfy branch protection — only the check carries a conclusion).
 *
 * The returned patch (`result.applied`) is what the caller may apply:
 * this caller never applies it, never modifies the pull-request
 * branch (review itself only edits a scratch worktree), and never
 * merges anything. Posting itself is the hosting layer's job; this
 * module returns the exact check and comment bodies to post.
 */

export interface PrReviewOutcome {
  /** What the PR declared (base ref, intent, optional related tests). */
  declaration: PrDeclaration;
  /** The ReviewResult, unchanged; `applied` is the patch the caller may apply. */
  result: ReviewResult;
  /** The gate, posted as a check. */
  check: PrReviewCheck;
  /** The senior note, posted as a comment. Never applied. */
  comment: PrReviewComment;
}

export interface PrReviewOptions {
  /**
   * Path to the PR checkout: a git working tree whose HEAD is the PR
   * head, carrying lesscode-pr.json at its root. This is the only
   * input that is not declared by the PR itself — it is where the PR
   * was checked out.
   */
  checkout: string;
  /** Test seam, same as review's: scripted model clients forwarded untouched. */
  sparkClient?: ReviewOptions["sparkClient"];
  wonderClient?: ReviewOptions["wonderClient"];
}

/** Read and validate the declaration the PR carries. Throws before any run on a bad declaration. */
export function readPrDeclaration(checkout: string): PrDeclaration {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(checkout, PR_DECLARATION_FILE), "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${PR_DECLARATION_FILE} in the PR checkout: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = prDeclarationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid ${PR_DECLARATION_FILE}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** The gate as a check: body is the gate result, conclusion from the gate alone. */
export function gateCheck(result: ReviewResult): PrReviewCheck {
  return {
    name: "lesscode/review",
    conclusion: result.gate?.accepted ? "success" : "failure",
    body: JSON.stringify(result.gate),
  };
}

/** The senior note as a comment: the cited note markdown, verbatim. */
export function noteComment(result: ReviewResult): PrReviewComment {
  return { body: result.review.markdown };
}

/** The two posts for one review() result: gate check + note comment. */
export function postFor(result: ReviewResult): PrReviewPost {
  return { check: gateCheck(result), comment: noteComment(result) };
}

/**
 * Resolve checkout/base/intent from the PR's declared files, call
 * review(), and return its gate as a check and its note as a comment.
 * The pull-request branch is not modified; the patch is returned in
 * `result.applied` for the caller, never applied here.
 */
export async function runPrReview(opts: PrReviewOptions): Promise<PrReviewOutcome> {
  const declaration = readPrDeclaration(opts.checkout);
  const result = await review({
    checkout: opts.checkout,
    base: declaration.baseRef,
    intent: declaration.intent,
    ...(declaration.relatedTests ? { relatedTests: declaration.relatedTests } : {}),
    ...(opts.sparkClient ? { sparkClient: opts.sparkClient } : {}),
    ...(opts.wonderClient ? { wonderClient: opts.wonderClient } : {}),
  });
  return { declaration, result, ...postFor(result) };
}
