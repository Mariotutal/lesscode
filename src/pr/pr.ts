import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SimplifyOptions, SimplifyResult } from "../simplify/simplify.js";
import { simplifyTool } from "../tool/tool.js";
import { PR_DECLARATION_FILE, prDeclarationSchema, type PrDeclaration, type PrSimplifyCheck } from "./schema.js";

/**
 * The pull-request caller of simplify.
 *
 * A third caller of the same simplify function — no second pipeline:
 * this file resolves { checkout, base, intent } from the files the
 * pull request declares, calls simplifyTool (which forwards to
 * simplify), and posts the returned gate result as a check. It does
 * not edit src/simplify, src/plan, src/classify, or src/gate, it does
 * not apply the returned patch, and it does not modify the pull
 * request branch (simplify itself only edits a scratch worktree).
 *
 * "Posts the check" means: returns the check object for the caller's
 * hosting layer to submit. The check is its own gate result — the
 * body is exactly JSON.stringify(result.gate), and the conclusion is
 * derived from the gate alone, so a failing gate can be wired as a
 * required check. Verdict text, findings, and plan text never
 * satisfy it. This caller never merges anything.
 */

export interface PrSimplifyOutcome {
  /** What the PR declared (base ref, intent, optional related tests). */
  declaration: PrDeclaration;
  /** The SimplifyResult, unchanged. `patch` is what the caller may apply. */
  result: SimplifyResult;
  /** The check to post: body is the gate result, conclusion from the gate alone. */
  check: PrSimplifyCheck;
}

export interface PrSimplifyOptions {
  /**
   * Path to the PR checkout: a git working tree whose HEAD is the PR
   * head, carrying lesscode-pr.json at its root. This is the only
   * input that is not declared by the PR itself — it is where the PR
   * was checked out.
   */
  checkout: string;
  /** Test seam, same as the tool's: scripted model clients forwarded to simplify untouched. */
  sparkClient?: SimplifyOptions["sparkClient"];
  wonderClient?: SimplifyOptions["wonderClient"];
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

/** The check for a result: body is the gate result, conclusion from the gate alone. */
export function gateCheck(result: SimplifyResult): PrSimplifyCheck {
  return {
    name: "lesscode/simplify",
    conclusion: result.gate?.accepted ? "success" : "failure",
    body: JSON.stringify(result.gate),
  };
}

/**
 * Resolve checkout/base/intent from the PR's declared files, call
 * simplifyTool, and post the returned gate result as a check.
 */
export async function runPrSimplifyCheck(opts: PrSimplifyOptions): Promise<PrSimplifyOutcome> {
  const declaration = readPrDeclaration(opts.checkout);
  const clients = {
    ...(opts.sparkClient ? { sparkClient: opts.sparkClient } : {}),
    ...(opts.wonderClient ? { wonderClient: opts.wonderClient } : {}),
  };
  const result = await simplifyTool.call(
    {
      checkout: opts.checkout,
      base: declaration.baseRef,
      intent: declaration.intent,
      ...(declaration.relatedTests ? { relatedTests: declaration.relatedTests } : {}),
    },
    clients,
  );
  return { declaration, result, check: gateCheck(result) };
}
