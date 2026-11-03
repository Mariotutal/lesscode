import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { corpusSchema, assessRecord, type InvocationReceipt } from '../eval/upstream/contracts.js';
import { boundedFetch } from '../eval/upstream/budget.js';

const cases = corpusSchema.parse(JSON.parse(readFileSync(new URL('../eval/upstream/manifest.json', import.meta.url), 'utf8')));
const c = cases[0]!;
const receipt = (): InvocationReceipt => ({ adapter: 'cli', startedAt: '2026-11-03T00:00:00Z', completedAt: '2026-11-03T00:00:01Z', attempts: 2,
  responseModels: ['observed-model'], responseTokens: 40, maxRequests: 4, maxPromptBytes: 32768, maxCompletionTokens: 8192 });
const record = () => ({ schemaVersion: 1, runId: 'unique-invocation', state: 'completed', verdict: 'reviewed', outcome: 'no-change',
  revision: { baseSha: c.base, headSha: c.head, scope: 'declared' }, execution: { kind: 'docker', policyVersion: 1, configSource: 'operator-environment', environmentId: `sha256:${'a'.repeat(64)}` },
  findings: [], findingIds: [], edits: [], gate: null, artifact: null, failure: null,
  verification: { status: 'not-run', treeHash: null }, review: { items: [], markdown: '' }, audit: {},
  manifest: { modelCalls: 2, callsByModel: { spark: 1, wonder: 1 }, responseModels: { spark: 'observed-model', wonder: 'observed-model' }, usage: { total_tokens: 40 }, promptHashes: ['a'.repeat(64), 'b'.repeat(64)] },
});

describe('upstream evaluation evidence', () => {
  it('refuses live mode without explicit operator credentials instead of loading .env', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../eval/upstream/run.ts', import.meta.url)), '--live'], {
      env: { PATH: process.env.PATH, LESSCODE_RUNNER_IMAGE: 'not-used:test' }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No .env is loaded');
    expect(result.stdout).not.toContain('Evidence:');
  });
  it('rejects placeholder revisions, duplicate cases and untrusted source URLs', () => {
    expect(() => corpusSchema.parse([{ ...c, base: '0'.repeat(40) }])).toThrow();
    expect(() => corpusSchema.parse([c, c])).toThrow();
    expect(() => corpusSchema.parse([{ ...c, repository: 'https://operator:secret@github.com/a/b.git' }])).toThrow();
    expect(() => corpusSchema.parse([{ ...c, license: { ...c.license, path: '../private' } }])).toThrow();
  });
  it('requires full canonical records and independent response observations', () => {
    expect(assessRecord(record(), c, 'cli', 1, receipt()).passed).toBe(true);
    expect(() => assessRecord({ schemaVersion: 1, runId: 'fake', verdict: 'reviewed' }, c, 'cli', 1, receipt())).toThrow();
    expect(assessRecord(record(), c, 'mcp', 1, receipt()).passed).toBe(false);
    expect(() => assessRecord(record(), c, 'cli', 1, { ...receipt(), attempts: undefined })).toThrow();
    expect(assessRecord(record(), c, 'cli', 1, { ...receipt(), responseModels: ['other'] }).passed).toBe(false);
    expect(assessRecord(record(), c, 'cli', 1, { ...receipt(), responseTokens: 1 }).passed).toBe(false);
  });
  it('does not reinterpret mismatches or exit codes as success', () => {
    expect(assessRecord(record(), c, 'cli', 0, receipt()).issues).toContain('adapter exit status mismatch');
    expect(assessRecord(record(), { ...c, expectedVerdict: 'accepted' }, 'cli', 1, receipt()).passed).toBe(false);
    const altered = record(); altered.revision.headSha = c.base;
    expect(assessRecord(altered, c, 'cli', 1, receipt()).issues).toContain('source revision mismatch');
    altered.execution.kind = 'trusted-local';
    expect(assessRecord(altered, c, 'cli', 1, receipt()).issues).toContain('isolation or provider provenance missing');
  });
  it('bounds actual requests and completion size without saving prompts', async () => {
    const observed = { ...receipt(), attempts: 0, responseModels: [], responseTokens: 0 };
    const delegate = vi.fn<typeof fetch>(async () => Response.json({ model: 'served', usage: { total_tokens: 7 } }));
    const send = boundedFetch('https://provider.invalid/v1/chat/completions', observed, delegate);
    const body = JSON.stringify({ model: 'configured', messages: [{ role: 'user', content: 'public source' }], tools: [], tool_choice: 'auto' });
    for (let n = 0; n < 4; n++) await send('https://provider.invalid/v1/chat/completions', { body });
    expect(JSON.parse(delegate.mock.calls[0]![1]!.body as string).max_tokens).toBe(8192);
    expect(delegate.mock.calls[0]![1]!.redirect).toBe('error');
    expect(observed.responseTokens).toBe(28);
    await expect(send('https://provider.invalid/v1/chat/completions', { body })).rejects.toThrow('budget');
    await expect(send('https://attacker.invalid', { body })).rejects.toThrow('unexpected endpoint');
    expect(delegate).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(observed)).not.toContain('public source');
  });
  it('rejects oversized requests before the transport is invoked', async () => {
    const delegate = vi.fn<typeof fetch>();
    const send = boundedFetch('https://provider.invalid', { ...receipt(), attempts: 0 }, delegate);
    await expect(send('https://provider.invalid', { body: 'x'.repeat(32769) })).rejects.toThrow('budget');
    expect(delegate).not.toHaveBeenCalled();
  });
});
