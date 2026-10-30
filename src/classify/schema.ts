import { z } from "zod";

/**
 * Closed finding set for the LessCode simplifier (AGENTS.md). Only
 * `single-use-abstraction`, `duplicate-helper`, and `convention-break`
 * are produced by the model; `scope-creep` is decided by code
 * (see scopeCreep.ts) and must never be emitted by the model.
 */
export const MODEL_CATEGORIES = [
  "single-use-abstraction",
  "duplicate-helper",
  "convention-break",
] as const;

export const FINDING_CATEGORIES = [...MODEL_CATEGORIES, "scope-creep"] as const;

export type ModelFindingCategory = (typeof MODEL_CATEGORIES)[number];
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

const line = z.number().int().positive();

export const citationSchema = z.object({
  file: z.string().min(1),
  startLine: line,
  endLine: line,
}).refine((c) => c.endLine >= c.startLine, {
  message: "endLine must be >= startLine",
});

/**
 * One evidence-based finding. `rationale` names the convention for
 * convention-break findings (fixability is decided by code, which can
 * either apply a mechanical fix or refuse the finding).
 */
export const findingSchema = z.object({
  category: z.enum(MODEL_CATEGORIES),
  /** File the finding is about; every citation must be in the checkout. */
  file: z.string().min(1),
  /** Lines cited as evidence. Must be non-empty; code verifies existence. */
  citations: z.array(citationSchema).min(1),
  /** Existing helper to retarget to (duplicate-helper only). */
  existingHelperFile: z.string().min(1).optional(),
  /** Convention name (convention-break only). */
  convention: z.string().min(1).optional(),
  rationale: z.string().min(1),
});

export const classifiedOutputSchema = z.object({
  findings: z.array(findingSchema),
});

export type Finding = z.infer<typeof findingSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type ClassifiedOutput = z.infer<typeof classifiedOutputSchema>;
