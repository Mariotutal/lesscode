import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectLegacyEvidence } from '../eval/live-corpus-30/integrity.js';

const corpus = new URL('../eval/live-corpus-30/', import.meta.url);
const digest = (name: string) => createHash('sha256').update(readFileSync(new URL(name, corpus))).digest('hex');

describe('legacy evaluation quarantine', () => {
  it('rejects live and passing flags without independent invocation evidence', () => {
    const report = inspectLegacyEvidence([
      { id: 'a', baseSha: '0'.repeat(40), headSha: '1'.repeat(40) },
      { id: 'b', baseSha: 'abcdef0123456789abcdef0123456789abcdef01', headSha: 'abcdef0123456789abcdef0123456789abcdef02' },
    ], { mode: 'live', results: [
      { id: 'a', expectedMatched: { guest: true, mcp: true, cli: true }, envelopeOk: true },
      { id: 'b', expectedMatched: true },
      { id: 'unexpected' },
    ] });
    expect(report.usableForReleaseDecision).toBe(false);
    expect(report.unpinnedCases).toEqual(['a']);
    expect(report.unexpectedResults).toEqual(['unexpected']);
  });

  it('reports absent cases and rejects malformed summaries', () => {
    expect(inspectLegacyEvidence([{ id: 'missing' }], { results: [] }).missingResults).toEqual(['missing']);
    expect(() => inspectLegacyEvidence([], {})).toThrow('results must be an array');
    expect(() => inspectLegacyEvidence([null], { results: [] })).toThrow('manifest must be an array');
  });

  it('refuses the former live command without rewriting the retained evidence', () => {
    const files = ['manifest.json', 'results.json'];
    const before = files.map(digest);
    const result = spawnSync(process.execPath, [
      '--import', 'tsx',
      fileURLToPath(new URL('harness.ts', corpus)),
    ], {
      env: { PATH: process.env.PATH, EVAL_LIVE: '1', EVAL_LIVE_REAL: '1' },
      encoding: 'utf8', timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Evaluation refused');
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'invalid-evaluation', usableForReleaseDecision: false,
      declaredCases: 30, recordedRows: 30,
    });
    expect(JSON.parse(result.stdout).unpinnedCases).toHaveLength(30);
    expect(files.map(digest)).toEqual(before);
  });
});
