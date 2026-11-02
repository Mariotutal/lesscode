import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadLesscodeConfig } from '../src/provider/configFile.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('bounds discovery to the approved root and observes creation, deletion and escaping links', () => {
  const parent = mkdtempSync(join(tmpdir(), 'lc-config-boundary-')); roots.push(parent);
  const root = join(parent, 'repo'); mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(parent, '.lesscode.json'), '{"version":1}');
  expect(loadLesscodeConfig(join(root, 'src'), { rootDir: root }).config).toBeNull();
  writeFileSync(join(root, '.lesscode.json'), '{"version":1}');
  expect(loadLesscodeConfig(join(root, 'src'), { rootDir: root }).config?.version).toBe(1);
  rmSync(join(root, '.lesscode.json'));
  expect(loadLesscodeConfig(root, { rootDir: root }).config).toBeNull();
  symlinkSync(join(parent, '.lesscode.json'), join(root, '.lesscode.json'));
  expect(() => loadLesscodeConfig(root, { rootDir: root })).toThrow(/escapes/);
});
