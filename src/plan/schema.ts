import { z } from "zod";

/**
 * Wonder plan schema (LES-4). muse-wonder-1.0 plans ONCE per run: it
 * chooses which classified findings become edits. It does not
 * reimplement the feature — an edit is a surgical inline / retarget /
 * restore-from-base / convention-fix, expressed as full contents for
 * the few files it touches plus deletions. Code validates every path
 * against the finding's cited files before anything is written; the
 * deterministic gate (src/gate) is the final judge.
 */
export const PLAN_ACTIONS = [
  "inline",
  "retarget",
  "restore-from-base",
  "convention-fix",
  "skip",
] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

export const plannedEditSchema = z.object({
  /** Index into the findings array given to the planner. */
  findingIndex: z.number().int().nonnegative(),
  action: z.enum(PLAN_ACTIONS),
  /** Full new contents for files this edit rewrites (inline/retarget only; code supplies restore/convention contents). */
  newFiles: z.array(z.object({ file: z.string().min(1), content: z.string() })).default([]),
  /** Files this edit deletes (the inlined wrapper / the duplicate copy). */
  deleteFiles: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1),
});

export const planOutputSchema = z.object({
  edits: z.array(plannedEditSchema),
});

export type PlannedEdit = z.infer<typeof plannedEditSchema>;
export type PlanOutput = z.infer<typeof planOutputSchema>;

/** One repair turn returns corrected contents for a single failing edit. */
export const repairOutputSchema = z.object({
  newFiles: z.array(z.object({ file: z.string().min(1), content: z.string() })).min(1),
});
export type RepairOutput = z.infer<typeof repairOutputSchema>;
