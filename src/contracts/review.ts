import { z } from 'zod';
import { reviewNoteItemSchema } from '../plan/schema.js';
import { noteVerificationSchema, reviewFactSchema } from '../review/claims.js';

/** Inputs contain source identity only; credentials and execution authority are host dependencies. */
export const reviewArgumentsSchema = z.object({
  checkout: z.string().min(1), base: z.string().min(1),
  intent: z.array(z.string().min(1)).min(1),
  relatedTests: z.array(z.string().min(1)).min(1).optional(),
}).strict();

export const runRecordSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string(),
  state: z.enum(['completed', 'failed', 'cancelled']),
  verdict: z.enum(['accepted', 'reviewed', 'failed']),
  outcome: z.enum(['patch-ready', 'review-only', 'no-change', 'unverified']).nullable(),
  revision: z.object({ headSha: z.string(), baseSha: z.string(), scope: z.enum(['declared', 'inferred']) }).nullable(),
  execution: z.object({ kind: z.enum(['trusted-local', 'docker']), policyVersion: z.number() }).passthrough(),
  findings: z.array(z.unknown()), findingIds: z.array(z.string()), edits: z.array(z.unknown()),
  gate: z.unknown().nullable(),
  verification: z.object({ status: z.enum(['verified', 'rejected', 'not-run']), treeHash: z.string().nullable() }),
  artifact: z.unknown().nullable(), review: z.object({
    items: z.array(reviewNoteItemSchema.extend({ verification: noteVerificationSchema.optional() })), markdown: z.string(),
    facts: z.array(reviewFactSchema).optional(),
    verification: z.object({ policyVersion: z.literal(1), verifiedItems: z.number().int().nonnegative(), unverifiedItems: z.number().int().nonnegative(), withheldItems: z.number().int().nonnegative() }).optional(),
  }),
  manifest: z.object({}).passthrough(), audit: z.object({}).passthrough(),
  failure: z.object({ stage: z.string(), message: z.string() }).nullable(),
}).passthrough();
