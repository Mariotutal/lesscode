import { z } from 'zod';
import { createHash } from 'node:crypto';
import { runRecordSchema } from '../../src/contracts/review.js';

export const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const commit = z.string().regex(/^[a-f0-9]{40}$/).refine((s) => !/^(.)\1+$/.test(s), 'placeholder SHA');
const path = z.string().min(1).refine((s) => !s.startsWith('/') && !s.split(/[\\/]/).some((p) => ['..', '.git', 'sealed'].includes(p)));
export const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  repository: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/),
  base: commit, head: commit,
  license: z.object({ spdx: z.literal('MIT'), path, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  intent: z.array(path).min(1), relatedTests: z.array(path).min(1),
  expectedVerdict: z.enum(['accepted', 'reviewed']),
  rationale: z.string().min(40),
  checks: z.array(z.object({ command: z.enum(['node', 'npm']), args: z.array(z.string()) }).strict()).min(1),
}).strict().refine((c) => c.base !== c.head, 'base and head must differ');
export const corpusSchema = z.array(caseSchema).min(1).refine((cases) => new Set(cases.map((c) => c.id)).size === cases.length, 'duplicate case id');
export type UpstreamCase = z.infer<typeof caseSchema>;
export const adapters = ['engine', 'mcp', 'cli'] as const;
export type Adapter = typeof adapters[number];

export interface InvocationReceipt {
  adapter: Adapter; startedAt: string; completedAt: string;
  attempts: number; responseModels: string[]; responseTokens: number;
  maxRequests: number; maxPromptBytes: number; maxCompletionTokens: number;
}

const receiptSchema = z.object({
  adapter: z.enum(adapters), startedAt: z.iso.datetime(), completedAt: z.iso.datetime(),
  attempts: z.number().int().min(1).max(4), responseModels: z.array(z.string().min(1)).min(1),
  responseTokens: z.number().finite().positive(), maxRequests: z.literal(4),
  maxPromptBytes: z.literal(32768), maxCompletionTokens: z.literal(8192),
}).strict();

/** A complete record plus independent transport observations, never legacy flags. */
export function assessRecord(input: unknown, c: UpstreamCase, adapter: Adapter, exitCode: number | null, receiptInput: unknown) {
  const receipt = receiptSchema.parse(receiptInput);
  const record = runRecordSchema.parse(input);
  const manifest = z.object({
    modelCalls: z.number().int().positive(),
    callsByModel: z.object({ spark: z.number().int().positive(), wonder: z.literal(1) }),
    responseModels: z.object({ spark: z.string().min(1), wonder: z.string().min(1) }),
    usage: z.object({ total_tokens: z.number().positive() }),
    promptHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(2),
  }).parse(record.manifest);
  const issues: string[] = [];
  if (record.state !== 'completed' || record.failure) issues.push('product execution failed');
  if (record.revision?.baseSha !== c.base || record.revision?.headSha !== c.head) issues.push('source revision mismatch');
  if (record.execution.kind !== 'docker' || record.execution.configSource !== 'operator-environment' || !/^sha256:[a-f0-9]{64}$/.test(String(record.execution.environmentId))) issues.push('isolation or provider provenance missing');
  if (record.verdict !== c.expectedVerdict) issues.push(`expected ${c.expectedVerdict}, observed ${record.verdict}`);
  if (exitCode !== (record.verdict === 'accepted' ? 0 : record.verdict === 'reviewed' ? 1 : 2)) issues.push('adapter exit status mismatch');
  if (receipt.adapter !== adapter || !receipt.completedAt || receipt.attempts < manifest.modelCalls || receipt.attempts > receipt.maxRequests) issues.push('transport invocation evidence inconsistent');
  if (!Object.values(manifest.responseModels).every((model) => receipt.responseModels.includes(model)) || receipt.responseTokens <= 0) issues.push('provider response evidence missing');
  if (manifest.promptHashes.length !== manifest.modelCalls || manifest.modelCalls !== manifest.callsByModel.spark + manifest.callsByModel.wonder) issues.push('model call evidence inconsistent');
  if (record.verdict === 'accepted') {
    const artifact = z.object({ patch: z.string().min(1), sha256: z.string(), baseSha: z.string(), headSha: z.string() }).parse(record.artifact);
    if (sha256(artifact.patch) !== artifact.sha256 || artifact.baseSha !== c.base || artifact.headSha !== c.head || record.verification.status !== 'verified') issues.push('accepted artifact is unverified');
  }
  return { passed: issues.length === 0, issues, verdict: record.verdict, runId: record.runId };
}
