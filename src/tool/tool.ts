import type { ToolDefinition } from "../classify/client.js";
import { simplify, type SimplifyOptions, type SimplifyResult } from "../simplify/simplify.js";
import { simplifyToolArgumentsSchema } from "./schema.js";

/** Tool name other agents call. */
export const SIMPLIFY_TOOL_NAME = "simplify";

/**
 * The one agent-callable tool: a function-calling definition (same
 * ToolDefinition shape the product's classify/plan calls use) plus
 * its handler. The handler is a thin adapter over the existing
 * simplify(checkout, base, intent) function — it forwards the
 * validated arguments verbatim and returns the SimplifyResult
 * unchanged ({ verdict, patch, findings, gate, ... }).
 *
 * The calling agent does not re-decide the verdict, and there is no
 * second pipeline here: no classify, plan, apply, or gate logic
 * lives in this file. The TypeScript gate inside simplify decides.
 */
export const SIMPLIFY_TOOL_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: SIMPLIFY_TOOL_NAME,
    description:
      "Run LessCode behavior-preserving simplification on a TypeScript pull request checkout. " +
      "Returns the SimplifyResult unchanged: verdict ('accepted' | 'refused'), patch (unified diff of the kept edits, empty when refused), " +
      "findings (closed set: single-use-abstraction, duplicate-helper, scope-creep decided by code, convention-break), and gate (the deterministic " +
      "gate result, or null when no edit reached it). The verdict is decided by the gate inside simplify — callers must not re-decide it. " +
      "A run never modifies the caller checkout/branch: the edits are applied in a scratch worktree, so a refused run leaves the caller branch unchanged.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["checkout", "base", "intent"],
      properties: {
        checkout: {
          type: "string",
          description: "Path to the PR checkout (a git working tree whose HEAD is the PR head). Never modified by the run.",
        },
        base: {
          type: "string",
          description: "Git ref the PR is diffed against (the PR's base).",
        },
        intent: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Required: the files the change claimed to touch. Any other changed file is scope creep and is restored from base by code.",
        },
        relatedTests: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Optional related test files/dirs the gate runs; defaults to ['tests'] inside simplify.",
        },
      },
    },
  },
};

export interface SimplifyTool {
  readonly definition: ToolDefinition;
  call(args: unknown, clients?: Pick<SimplifyOptions, "sparkClient" | "wonderClient">): Promise<SimplifyResult>;
}

/**
 * Build the tool. `run` defaults to the real simplify; it exists only
 * so tests can drive the tool with a scripted model end-to-end (the
 * scripted clients are forwarded to simplify untouched) — it is not a
 * second pipeline.
 */
export function createSimplifyTool(run: typeof simplify = simplify): SimplifyTool {
  return {
    definition: SIMPLIFY_TOOL_DEF,
    async call(args, clients) {
      const parsed = simplifyToolArgumentsSchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`invalid simplify tool arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      }
      const { checkout, base, intent, relatedTests } = parsed.data;
      return run({ checkout, base, intent, relatedTests, ...clients });
    },
  };
}

/** The tool as other agents call it. */
export const simplifyTool: SimplifyTool = createSimplifyTool();
