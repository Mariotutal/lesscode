import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runRecordSchema } from '../src/contracts/review.js';

it('installed entry writes a real failed record, preserves config, and exits 2 from another cwd', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lc-cli-contract-'));
  const config = '{"version":1}\n';
  writeFileSync(join(cwd, '.lesscode.json'), config);
  try {
    const result = spawnSync(process.execPath, [resolve('scripts/lesscode.mjs'), 'review', '--repo', cwd, '--base', 'HEAD', '--intent', 'a.ts', '--out', 'result.json'], { cwd, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    expect(result.status).toBe(2);
    const record = JSON.parse(readFileSync(join(cwd, 'result.json'), 'utf8'));
    expect(runRecordSchema.safeParse(record).success).toBe(true);
    expect(record.verdict).toBe('failed');
    expect(readFileSync(join(cwd, '.lesscode.json'), 'utf8')).toBe(config);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
