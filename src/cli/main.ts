import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runReview } from '../engine/run.js';
import { createDockerExecutor } from '../execution/index.js';
import { parseArgs, exitCodeForVerdict } from './args.js';
import { runRecordSchema } from '../contracts/review.js';

const usage = 'lesscode review|tool --repo <path> --base <ref> --intent <files> --out <result.json> [--execution local|docker] [--runner-image <image>]';
let executor: ReturnType<typeof createDockerExecutor> | undefined;
try {
  const [command, ...rest] = process.argv.slice(2);
  if (command === '--help' || command === '-h') console.log(usage);
  else {
    if (!['review', 'tool'].includes(command ?? '')) throw new Error(usage);
    const args = parseArgs(rest, [
      { name: 'repo', kind: 'value', required: true }, { name: 'base', kind: 'value', required: true },
      { name: 'intent', kind: 'list', required: true }, { name: 'out', kind: 'value', required: true },
      { name: 'tests', kind: 'list' }, { name: 'execution', kind: 'value' }, { name: 'runner-image', kind: 'value' },
    ], usage);
    if (args.help) console.log(usage);
    else {
      const execution = args.values.get('execution') ?? 'local';
      if (!['local', 'docker'].includes(execution)) throw new Error('execution must be local or docker');
      if (execution === 'docker') {
        const image = args.values.get('runner-image') ?? process.env.LESSCODE_RUNNER_IMAGE;
        if (!image) throw new Error('Docker execution requires an operator-approved runner image');
        executor = createDockerExecutor({ image });
      }
      const record = await runReview({ checkout: resolve(args.values.get('repo')!), base: args.values.get('base')!, intent: args.lists.get('intent')!, relatedTests: args.lists.get('tests'), executor });
      runRecordSchema.parse(record);
      const output = resolve(args.values.get('out')!);
      mkdirSync(dirname(output), { recursive: true });
      const temporary = `${output}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, output); }
      finally { rmSync(temporary, { force: true }); }
      console.log(output);
      process.exitCode = exitCodeForVerdict(record.verdict);
    }
  }
} catch (error) { console.error(error instanceof Error ? error.message : 'LessCode failed'); process.exitCode = 2; }
finally { await executor?.dispose(); }
