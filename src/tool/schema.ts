import { z } from "zod";
import { reviewArgumentsSchema } from '../contracts/review.js';

/**
 * Arguments of the `simplify` tool: exactly the inputs of
 * simplify(checkout, base, intent). `intent` is required — it is the
 * list of files the change claimed to touch; scope creep is decided
 * from it. `relatedTests` is optional and defaults to ["tests"]
 * inside simplify.
 */
export const simplifyToolArgumentsSchema = reviewArgumentsSchema;

export type SimplifyToolArguments = z.infer<typeof simplifyToolArgumentsSchema>;
