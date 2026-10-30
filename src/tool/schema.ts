import { z } from "zod";

/**
 * Arguments of the `simplify` tool: exactly the inputs of
 * simplify(checkout, base, intent). `intent` is required — it is the
 * list of files the change claimed to touch; scope creep is decided
 * from it. `relatedTests` is optional and defaults to ["tests"]
 * inside simplify.
 */
export const simplifyToolArgumentsSchema = z.object({
  checkout: z.string().min(1),
  base: z.string().min(1),
  intent: z.array(z.string().min(1)).min(1),
  relatedTests: z.array(z.string().min(1)).min(1).optional(),
});

export type SimplifyToolArguments = z.infer<typeof simplifyToolArgumentsSchema>;
