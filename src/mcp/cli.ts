import { createServer } from 'node:http';
import { startStdio, createHttpHandler } from './server.js';

try {
  const root = process.env.LESSCODE_MCP_ROOT;
  if (!root) throw new Error('LESSCODE_MCP_ROOT is required');
  const options = { root, runnerImage: process.env.LESSCODE_RUNNER_IMAGE };
  if (process.argv.includes('--http')) {
    const token = process.env.LESSCODE_MCP_TOKEN ?? '';
    const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => { void handler(req, res); });
    const handler = createHttpHandler({ ...options, token });
    server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1');
  } else await startStdio({ ...options, trustedLocal: process.env.LESSCODE_MCP_TRUST_LOCAL === '1' });
} catch (error) { console.error(error instanceof Error ? error.message : 'MCP startup failed'); process.exitCode = 2; }
