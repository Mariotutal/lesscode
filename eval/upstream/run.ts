import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDockerExecutor, repositoryEnvironment } from '../../src/execution/index.js';
import { redactSecrets } from '../../src/provider/configFile.js';
import { adapters, assessRecord, corpusSchema, sha256, type InvocationReceipt } from './contracts.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const flags = process.argv.slice(2);
if (flags.some((flag) => !['--live', '--baseline'].includes(flag)) || flags.length > 1) throw new Error('Usage: npx tsx eval/upstream/run.ts [--baseline|--live]');
const live = flags.includes('--live');
const image = process.env.LESSCODE_RUNNER_IMAGE;
if (!image) throw new Error('LESSCODE_RUNNER_IMAGE must name an approved preinstalled Docker image');
if (live && (!process.env.LESSCODE_API_KEY || !process.env.LESSCODE_API_BASE_URL || !process.env.LESSCODE_SPARK_MODEL || !process.env.LESSCODE_WONDER_MODEL)) {
  throw new Error('Live runs require explicit LESSCODE_API_KEY, LESSCODE_API_BASE_URL, LESSCODE_SPARK_MODEL and LESSCODE_WONDER_MODEL in the operator environment. No .env is loaded.');
}
const text = readFileSync(new URL('./manifest.json', import.meta.url), 'utf8');
const cases = corpusSchema.parse(JSON.parse(text));
// Keep the initial live experiment bounded. Expansion requires a reviewed change.
if (cases.length > 3) throw new Error('Initial upstream pilot is limited to three cases');
const work = mkdtempSync(join(tmpdir(), 'lesscode-upstream-'));
const env = { ...repositoryEnvironment(work), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const command = async (cwd: string, cmd: string, args: string[]) => {
  const commandEnv: NodeJS.ProcessEnv = { ...env };
  if (cmd === 'docker') for (const key of ['HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) if (process.env[key]) commandEnv[key] = process.env[key];
  try { return (await exec(cmd, args, { cwd, env: commandEnv, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
  catch { throw new Error(`operator command failed: ${cmd} ${args[0] ?? ''}`); }
};
const git = (cwd: string, args: string[]) => command(cwd, 'git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args]);
const save = (path: string, data: unknown) => {
  const value = JSON.stringify(data, null, 2) + '\n';
  if (redactSecrets(value) !== value) throw new Error('artifact withheld: contains an operator secret');
  writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
};
const distHash = (dir: string): string => sha256(readdirSync(dir).sort().map((name) => {
  const path = join(dir, name);
  return `${name}:${statSync(path).isDirectory() ? distHash(path) : sha256(readFileSync(path))}`;
}).join('\n'));
const output = resolve(root, '.lesscode-eval', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
mkdirSync(output, { recursive: true, mode: 0o700 });
let allPassed = true;
try {
  if (await git(root, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Commit tracked evaluator/product changes before recording provenance');
  await command(root, 'npm', ['run', 'build']);
  const productCommit = await git(root, ['rev-parse', 'HEAD']);
  const imageId = await command(root, 'docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Runner image is not immutable');
  save(join(output, 'provenance.json'), { schemaVersion: 1, mode: live ? 'live' : 'baseline-only', productCommit, evaluatorCommit: productCommit,
    distSha256: distHash(join(root, 'dist')), manifestSha256: sha256(text), imageId, node: process.version,
    adapters: live ? adapters : [], budgets: { maxCases: 3, requestsPerAdapter: 4, promptBytesPerRequest: 32768, completionTokensPerRequest: 8192 },
    limitations: ['One curated upstream change, not a 30-project corpus', 'Dependency inventory is captured; upstream has no committed lockfile', 'Skill command is exercised by CLI; agent skill selection is not evaluated', 'Live outcome checks require independent human review of notes and patches'] });
  save(join(output, 'manifest.json'), cases);
  for (const c of cases) {
    const directory = join(output, c.id); mkdirSync(directory, { mode: 0o700 });
    const source = join(work, c.id); mkdirSync(source);
    const summary: { status: string; issues: string[]; adapters: Record<string, unknown> } = { status: 'failed', issues: [], adapters: {} };
    try {
      await git(source, ['init', '-q']);
      await git(source, ['remote', 'add', 'origin', c.repository]);
      await git(source, ['fetch', '--quiet', '--depth=2', 'origin', c.base, c.head]);
      if (await git(source, ['rev-parse', `${c.head}^`]) !== c.base) throw new Error('Pilot requires the actual first-parent upstream change');
      const patch = await git(source, ['diff', '--binary', c.base, c.head]);
      save(join(directory, 'source.json'), { repository: c.repository, base: c.base, head: c.head, patch, patchSha256: sha256(patch) });
      for (const [label, revision] of [['base', c.base], ['head', c.head]]) {
        const tree = await git(source, ['ls-tree', '-r', revision!]);
        if (/^(120000|160000) /m.test(tree)) throw new Error('Pilot refuses upstream symlinks and submodules');
        await git(source, ['checkout', '--quiet', '--detach', revision!]);
        if (sha256(readFileSync(join(source, c.license.path))) !== c.license.sha256) throw new Error('Pinned license hash mismatch');
        save(join(directory, `${label}-license.json`), { ...c.license, text: readFileSync(join(source, c.license.path), 'utf8') });
        const executor = createDockerExecutor({ image: imageId, timeoutMs: 120_000 });
        try {
          await executor.prepare(source);
          const inventory = await executor.run({ repoDir: source, command: 'npm', args: ['ls', '--json', '--all'], timeoutMs: 30_000 });
          save(join(directory, `${label}-dependencies.json`), inventory);
          if (inventory.exitCode !== 0 || inventory.error) throw new Error(`${label} dependency inventory failed`);
          const results = [];
          for (const check of c.checks) {
            const result = await executor.run({ repoDir: source, command: check.command, args: check.args, timeoutMs: 120_000 });
            results.push({ ...check, ...result });
          }
          save(join(directory, `${label}-checks.json`), results);
          if (results.some((r) => r.exitCode !== 0 || r.timedOut || r.error)) throw new Error(`${label} checks failed; no model calls allowed`);
          if (await git(source, ['status', '--porcelain', '--untracked-files=all'])) throw new Error(`${label} verification changed source`);
        } finally { await executor.dispose(); }
      }
      const runIds = new Set<string>();
      if (live) for (const adapter of adapters) {
        const out = join(directory, `${adapter}.json`);
        // Deliberately select only operator model configuration, not the entire host environment.
        const workerEnv: NodeJS.ProcessEnv = { ...repositoryEnvironment(work),
          LESSCODE_API_KEY: process.env.LESSCODE_API_KEY!, LESSCODE_API_BASE_URL: process.env.LESSCODE_API_BASE_URL!,
          LESSCODE_SPARK_MODEL: process.env.LESSCODE_SPARK_MODEL!, LESSCODE_WONDER_MODEL: process.env.LESSCODE_WONDER_MODEL! };
        for (const key of ['HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) if (process.env[key]) workerEnv[key] = process.env[key];
        const startedAt = new Date().toISOString();
        const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./worker.ts', import.meta.url)),
          adapter, source, c.base, JSON.stringify(c.intent), JSON.stringify(c.relatedTests), imageId, out],
        { cwd: root, env: workerEnv, encoding: 'utf8', timeout: 900_000, maxBuffer: 4 * 1024 * 1024 });
        save(join(directory, `${adapter}-process.json`), { startedAt, completedAt: new Date().toISOString(), exitCode: child.status,
          error: child.error ? redactSecrets(child.error.message) : null, stderr: redactSecrets(child.stderr ?? ''), stdout: redactSecrets(child.stdout ?? '') });
        try {
          if (child.error) throw new Error('adapter process did not complete');
          const raw = readFileSync(out, 'utf8');
          if (redactSecrets(raw) !== raw) { rmSync(out); throw new Error('adapter record withheld: contains secret'); }
          const receipt = JSON.parse(readFileSync(`${out}.receipt.json`, 'utf8')) as InvocationReceipt;
          const result = assessRecord(JSON.parse(raw), c, adapter, child.status, receipt);
          if (runIds.has(result.runId)) throw new Error('duplicate adapter run id');
          runIds.add(result.runId);
          summary.adapters[adapter] = result;
          if (!result.passed) summary.issues.push(...result.issues.map((issue) => `${adapter}: ${issue}`));
        } catch { summary.issues.push(`${adapter}: missing or invalid execution evidence`); }
      }
      summary.status = summary.issues.length ? 'failed' : live ? 'live-records-validated-human-review-required' : 'baseline-passed-not-model-evaluated';
    } catch (error) { summary.issues.push(redactSecrets(error instanceof Error ? error.message : 'case failed')); }
    if (summary.issues.length) allPassed = false;
    save(join(directory, 'summary.json'), summary);
    console.log(`${c.id}: ${summary.status}`);
  }
  save(join(output, 'summary.json'), { mode: live ? 'live' : 'baseline-only', allPassed, completedAt: new Date().toISOString(),
    modelQualityEstablished: false, note: live ? 'Canonical records validated mechanically; human review still required.' : 'No model or adapter invocation performed.' });
  process.exitCode = allPassed ? 0 : 1;
} finally { rmSync(work, { recursive: true, force: true }); console.log(`Evidence: ${output}`); }
