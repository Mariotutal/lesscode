import { runReview } from "../engine/run.js";
import type { ReviewRequest, RunRecord } from "../engine/types.js";
import { simplifyToolArgumentsSchema } from "./schema.js";
import { SIMPLIFY_TOOL_DEF } from "./tool.js";
import type { ToolDefinition } from "../classify/client.js";

export const REVIEW_TOOL_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "review_change",
    description: "Review a local JavaScript/TypeScript change using the single LessCode engine. Returns a versioned run record with a cited note, edit outcomes, verification evidence, and an accepted patch artifact when verified. The verdict is final. Execution policy is selected by the host, never by the model.",
    parameters: SIMPLIFY_TOOL_DEF.function.parameters,
  },
};

export function createReviewTool(dependencies: Pick<ReviewRequest, "sparkClient" | "wonderClient" | "executor" | "signal"> = {}) {
  return {
    definition: REVIEW_TOOL_DEF,
    async call(args: unknown): Promise<RunRecord> {
      const validated = simplifyToolArgumentsSchema.parse(args);
      return runReview({ ...validated, ...dependencies });
    },
  };
}
