/** Real engine review of paired synthetic holdouts; facts are never sent to models. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDockerExecutor, repositoryEnvironment } from '../../src/execution/index.js';
import { runRecordSchema } from '../../src/contracts/review.js';
import { redactSecrets } from '../../src/provider/configFile.js';
import { accuracyCases } from './accuracy-cases.js';
import { assessRecord, sha256, type InvocationReceipt } from './contracts.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (process.argv.slice(2).join(' ') !== '--live') throw new Error('Usage: node --import tsx eval/upstream/accuracy.ts --live (real model usage, no .env loading)');
for (const name of ['LESSCODE_API_KEY', 'LESSCODE_API_BASE_URL', 'LESSCODE_SPARK_MODEL', 'LESSCODE_WONDER_MODEL', 'LESSCODE_RUNNER_IMAGE']) {
  if (!process.env[name]) throw new Error(`Operator must provide ${name}`);
}
const work = mkdtempSync(join(tmpdir(), 'lc-accuracy-'));
const gitEnv = { ...repositoryEnvironment(work), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: gitEnv, encoding: 'utf8' }).trim();
if (git(root, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Commit tracked changes before recording a live accuracy run');
const revision = git(root, ['rev-parse', 'HEAD']);
const out = join(root, '.lesscode-eval', `accuracy-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
mkdirSync(out, { recursive: true, mode: 0o700 });
const save = (name: string, data: unknown) => {
  const text = JSON.stringify(data, null, 2) + '\n';
  if (redactSecrets(text) !== text) throw new Error('Secret-bearing evidence withheld');
  writeFileSync(join(out, name), text, { flag: 'wx', mode: 0o600 });
};
const results: unknown[] = [];
let passed = true;
try {
  const image = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', process.env.LESSCODE_RUNNER_IMAGE!], { encoding: 'utf8' }).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('No immutable approved runner image');
  save('provenance.json', { revision, image, kind: 'synthetic-paired-holdouts', caseSha256: sha256(JSON.stringify(accuracyCases)),
    noteQualityScored: false, note: 'Runtime/assertion facts are independently established. Read notes against facts; no regex accuracy percentage is asserted.' });
  for (const c of accuracyCases) {
    console.log(`${c.id}: establish runtime facts`);
    const repo = join(work, c.id); mkdirSync(join(repo, 'src'), { recursive: true }); mkdirSync(join(repo, 'tests'));
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'accuracy-case', version: '1.0.0', type: 'module', scripts: { test: 'node --test tests/*.test.js' } }));
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(repo, 'tests/module.test.js'), c.tests);
    writeFileSync(join(repo, 'src/module.js'), c.base);
    git(repo, ['init', '-q', '-b', 'base']); git(repo, ['add', '.']);
    git(repo, ['-c', 'user.name=Eval', '-c', 'user.email=eval@localhost', 'commit', '-qm', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-qb', 'change']);
    writeFileSync(join(repo, 'src/module.js'), c.head);
    git(repo, ['add', '.']); git(repo, ['-c', 'user.name=Eval', '-c', 'user.email=eval@localhost', 'commit', '-qm', 'head']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    const observations = [];
    for (const [sha, probe] of [[base, c.baseProbe], [head, c.headProbe]]) {
      git(repo, ['checkout', '--quiet', '--detach', sha!]);
      const executor = createDockerExecutor({ image });
      try {
        await executor.prepare(repo);
        for (const command of [{ command: 'npm', args: ['test'] }, { command: 'node', args: ['--input-type=module', '-e', `import assert from 'node:assert/strict'; ${probe}`] }]) {
          const result = await executor.run({ repoDir: repo, ...command, timeoutMs: 30_000 });
          observations.push({ sha, ...command, ...result });
          if (result.exitCode !== 0 || result.error) throw new Error(`${c.id}: independent behavior probe failed`);
        }
      } finally { await executor.dispose(); }
    }
    save(`${c.id}-oracle.json`, { ...c, baseSha: base, headSha: head, observations });
    const env: NodeJS.ProcessEnv = { ...repositoryEnvironment(work) };
    for (const key of ['HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'LESSCODE_API_KEY', 'LESSCODE_API_BASE_URL', 'LESSCODE_SPARK_MODEL', 'LESSCODE_WONDER_MODEL']) if (process.env[key]) env[key] = process.env[key];
    const output = join(out, `${c.id}.json`);
    console.log(`${c.id}: real engine invocation`);
    const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./worker.ts', import.meta.url)), 'engine', repo, base, '["src/module.js"]', '["tests"]', image, output],
      { cwd: root, env, encoding: 'utf8', timeout: 420_000, maxBuffer: 4 * 1024 * 1024 });
    save(`${c.id}-process.json`, { exitCode: child.status, stdout: redactSecrets(child.stdout ?? ''), stderr: redactSecrets(child.stderr ?? ''), error: child.error ? redactSecrets(child.error.message) : null });
    const raw = readFileSync(output, 'utf8');
    if (redactSecrets(raw) !== raw) { rmSync(output); throw new Error('Record withheld: contains a secret'); }
    const record = runRecordSchema.parse(JSON.parse(raw));
    const receipt = JSON.parse(readFileSync(`${output}.receipt.json`, 'utf8')) as InvocationReceipt;
    const assessment = assessRecord(record, { base, head, expectedVerdict: 'reviewed' }, 'engine', child.status, receipt);
    const mechanicalPass = !child.error && assessment.passed && !record.artifact;
    if (!mechanicalPass) passed = false;
    results.push({ id: c.id, mechanicalPass, notes: record.review.items, facts: c.facts, receipt, recordSha256: sha256(raw) });
    console.log(`${c.id}: ${record.verdict}, ${record.review.items.length} notes`);
  }
  save('results.json', { revision, mechanicalChecksPassed: passed, noteQualityScored: false, results });
  process.exitCode = passed ? 0 : 1;
} finally { rmSync(work, { recursive: true, force: true }); console.log(`Evidence: ${out}`); }
