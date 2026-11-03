import { z } from 'zod';

export const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof scalarSchema>;
export const factualClaimSchema = z.object({
  factId: z.string().min(1).max(100),
  assertion: z.string().min(1).max(100),
  value: scalarSchema.optional(),
}).strict();
export type FactualClaim = z.infer<typeof factualClaimSchema>;
export interface ReviewFact {
  id: string;
  kind: 'primitive-trace' | 'assertion-inputs';
  file: string; startLine: number; endLine: number; sourceHash: string;
  symbol: string;
  assertion: string;
  inputs?: string[];
  values?: Scalar[];
  assumptions: string[];
}
export interface ClaimCheck extends FactualClaim {
  status: 'verified' | 'contradicted' | 'unverified';
  reason: string;
}
export interface NoteVerification {
  status: 'verified' | 'unverified';
  basis: 'code-rendered-facts' | 'unstructured-model-advice';
  claims: ClaimCheck[];
}

export const claimCheckSchema = factualClaimSchema.extend({ status: z.enum(['verified', 'contradicted', 'unverified']), reason: z.string() });
export const noteVerificationSchema = z.object({ status: z.enum(['verified', 'unverified']), basis: z.enum(['code-rendered-facts', 'unstructured-model-advice']), claims: z.array(claimCheckSchema) });
export const reviewFactSchema = z.object({
  id: z.string(), kind: z.enum(['primitive-trace', 'assertion-inputs']), file: z.string(),
  startLine: z.number().int().positive(), endLine: z.number().int().positive(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  symbol: z.string(), assertion: z.string(), inputs: z.array(z.string()).optional(), values: z.array(scalarSchema).optional(), assumptions: z.array(z.string()),
});
