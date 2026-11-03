/** One real adapter per process. Repository commands stay inside Docker. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { runReview } from '../../src/engine/run.js';
import { createDockerExecutor } from '../../src/execution/index.js';
import { adapters, type Adapter, type InvocationReceipt } from './contracts.js';
import { boundedFetch } from './budget.js';

const [name, checkout, base, intentJson, testsJson, image, out] = process.argv.slice(2);
if (!adapters.includes(name as Adapter) || !checkout || !base || !intentJson || !testsJson || !image || !out) throw new Error('invalid evaluation worker arguments');
const adapter = name as Adapter;
const baseUrl = new URL(process.env.LESSCODE_API_BASE_URL!);
if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error('live endpoint must be operator-selected HTTPS');
const endpoint = `${baseUrl.href.replace(/\/$/, '')}/chat/completions`;
const receipt: InvocationReceipt = { adapter, startedAt: new Date().toISOString(), completedAt: '', attempts: 0, responseModels: [], responseTokens: 0, maxRequests: 4, maxPromptBytes: 32768, maxCompletionTokens: 8192 };
globalThis.fetch = boundedFetch(endpoint, receipt, globalThis.fetch);
try {
  const input = { checkout: resolve(checkout), base, intent: JSON.parse(intentJson) as string[], relatedTests: JSON.parse(testsJson) as string[] };
  if (adapter === 'cli') {
    process.argv = [process.execPath, 'lesscode', 'review', '--repo', input.checkout, '--base', base,
      '--intent', input.intent.join(','), '--tests', input.relatedTests.join(','), '--out', out, '--execution', 'docker', '--runner-image', image];
    // Exercise the built public executable, not a replacement callback.
    await import(new URL('../../bin/lesscode', import.meta.url).href);
  } else {
    let record: unknown;
    if (adapter === 'engine') {
      const executor = createDockerExecutor({ image });
      try { record = await runReview({ ...input, executor, signal: AbortSignal.timeout(300_000) }); }
      finally { await executor.dispose(); }
    } else {
      const server = createMcpServer({ root: input.checkout, runnerImage: image });
      const client = new Client({ name: 'lesscode-upstream-eval', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(a); await client.connect(b);
        const result = await client.callTool({ name: 'review_change', arguments: input }, undefined, { timeout: 300_000 });
        if (result.isError) throw new Error('MCP review_change returned an error');
        record = result.structuredContent;
      } finally { await client.close(); await server.close(); }
    }
    writeFileSync(out, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const verdict = (record as { verdict?: string })?.verdict;
    process.exitCode = verdict === 'accepted' ? 0 : verdict === 'reviewed' ? 1 : 2;
  }
} finally {
  receipt.completedAt = new Date().toISOString();
  writeFileSync(`${out}.receipt.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
