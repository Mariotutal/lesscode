import { z } from "zod";

/**
 * The files a pull request declares, and what this caller posts.
 *
 * The PR declares — in a declaration file inside its own checkout, so
 * the declaration is part of the PR, not of the caller's environment:
 *
 *   <checkout>/lesscode-pr.json
 *     {
 *       "baseRef": "base",                        // git ref the PR is diffed against
 *       "intent": ["src/a.ts", "src/b.ts"],       // files the change claimed to touch
 *       "relatedTests": ["tests"]                 // optional
 *     }
 *
 * The checkout itself is the working tree the declaration lives in
 * (HEAD is the PR head). Nothing else is taken from the environment:
 * checkout, base, and intent all resolve from what the PR declares.
 *
 * Two different posts come out of one review() run:
 *  - a CHECK whose body is exactly the gate result and whose
 *    conclusion derives from the gate alone, so a failing gate can
 *    be a required check;
 *  - a COMMENT whose body is exactly the senior-note markdown. A
 *    comment cannot satisfy branch protection, by construction:
 *    only the check carries a conclusion, and only the check is
 *    built from the gate.
 */

/** File a PR carries to declare its base ref and intent. */
export const PR_DECLARATION_FILE = "lesscode-pr.json";

/** Schema of lesscode-pr.json. */
export const prDeclarationSchema = z.object({
  baseRef: z.string().min(1),
  intent: z.array(z.string().min(1)).min(1),
  relatedTests: z.array(z.string().min(1)).min(1).optional(),
});

export type PrDeclaration = z.infer<typeof prDeclarationSchema>;

/**
 * The gate check. `body` is exactly `JSON.stringify(result.gate)`
 * (the string "null" when no edit reached the gate, which is also a
 * failing check). `conclusion` derives from the gate alone: success
 * iff the gate ran and accepted. Verdict text, findings, and the
 * senior note never decide it — the note is the comment, and a
 * comment cannot satisfy branch protection.
 */
export type PrReviewCheck = {
  name: "lesscode/review";
  conclusion: "success" | "failure";
  body: string;
};

/**
 * The senior-note comment. `body` is exactly `result.review.markdown`
 * — cited lead-review prose, never applied. It carries no conclusion
 * and is never consulted by the check.
 */
export type PrReviewComment = {
  body: string;
};

export type PrReviewPost = {
  check: PrReviewCheck;
  comment: PrReviewComment;
};
