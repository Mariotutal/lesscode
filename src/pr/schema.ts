import { z } from "zod";

/**
 * The files a pull request declares, and the check it receives.
 *
 * A pull request is a third caller of the same simplify function
 * (after simplify() itself and the agent tool). It declares — in a
 * declaration file inside its own checkout, so the declaration is
 * part of the PR, not of the caller's environment:
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
 */

/** File a PR carries to declare its base ref and intent. */
export const PR_DECLARATION_FILE = "lesscode-pr.json";

/** Schema of lesscode-pr.json: same names/validation as the simplify tool arguments. */
export const prDeclarationSchema = z.object({
  baseRef: z.string().min(1),
  intent: z.array(z.string().min(1)).min(1),
  relatedTests: z.array(z.string().min(1)).min(1).optional(),
});

export type PrDeclaration = z.infer<typeof prDeclarationSchema>;

/**
 * A check whose body is the gate result — and nothing else.
 *
 * The conclusion is derived from the gate alone: `success` iff the
 * gate ran and accepted, otherwise `failure`. The verdict text,
 * findings, and plan text never decide the conclusion (they cannot
 * satisfy branch protection). A refused run whose edits never reached
 * the gate has `gate: null`, and that too is a failing check.
 *
 * `patch` is what the caller (e.g. a bot or a human) may apply; this
 * caller never applies it and never modifies the PR branch.
 */
export type PrSimplifyCheck = {
  name: "lesscode/simplify";
  conclusion: "success" | "failure";
  body: string;
};
