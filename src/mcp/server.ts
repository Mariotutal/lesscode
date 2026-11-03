import { timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { reviewArgumentsSchema, runRecordSchema } from '../contracts/review.js';
import { runReview } from '../engine/run.js';
import type { ReviewRequest } from '../engine/types.js';
import { createDockerExecutor } from '../execution/index.js';

export const reviewInput = reviewArgumentsSchema;
export interface McpOptions {
  root: string;
  runnerImage?: string;
  trustedLocal?: boolean;
  run?: typeof runReview;
}

/** Execution and filesystem authority belong to the host, never tool arguments. */
export function createMcpServer(options: McpOptions) {
  const root = realpathSync(options.root);
  const server = new McpServer({ name: 'lesscode', version: '0.1.0' });
  server.registerTool('review_change', {
    description: 'Review a change and return the canonical RunRecord. The engine decides the patch verdict. Review-item verification is separate: verified bounded facts include their assumptions; unverified model advice is not fact-checked.',
    inputSchema: reviewInput,
    outputSchema: runRecordSchema,
  }, async (input, extra) => {
    const checkout = realpathSync(input.checkout);
    const path = relative(root, checkout);
    if (isAbsolute(path) || path === '..' || path.startsWith('../') || checkout.split(/[\\/]/).includes('sealed')) throw new Error('checkout is outside approved root');
    if (!options.trustedLocal && !options.runnerImage) throw new Error('isolated execution requires an approved runner image');
    const executor = options.trustedLocal ? undefined : createDockerExecutor({ image: options.runnerImage! });
    const controller = new AbortController();
    const cancel = () => controller.abort(extra.signal.reason);
    extra.signal.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(() => controller.abort(new Error('review exceeded MCP deadline')), 900_000);
    try {
      if (extra.signal.aborted) cancel();
      const record = await (options.run ?? runReview)({ ...input, checkout, executor, signal: controller.signal } satisfies ReviewRequest);
      return { structuredContent: { ...record }, content: [{ type: 'text' as const, text: JSON.stringify(record) }] };
    } finally { clearTimeout(deadline); extra.signal.removeEventListener('abort', cancel); await executor?.dispose(); }
  });
  return server;
}

export async function startStdio(options: McpOptions) {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}

/** Stateless Streamable HTTP, with bounded requests and mandatory bearer authentication. */
export function createHttpHandler(options: McpOptions & { token: string; origins?: string[]; maxBodyBytes?: number }) {
  if (options.token.length < 32) throw new Error('MCP HTTP token must contain at least 32 characters');
  if (options.trustedLocal) throw new Error('MCP HTTP requires isolated repository execution');
  if (!options.runnerImage) throw new Error('MCP HTTP requires an approved runner image');
  const expected = Buffer.from(`Bearer ${options.token}`);
  let active = 0;
  return async (request: IncomingMessage, response: ServerResponse) => {
    const fail = (status: number, message: string) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: message })); };
    const actual = Buffer.from(request.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { fail(401, 'authentication required'); return; }
    if (request.headers.origin && !(options.origins ?? []).includes(request.headers.origin)) { fail(403, 'origin denied'); return; }
    if (request.url !== '/mcp') { fail(404, 'route not found'); return; }
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); fail(405, 'method not allowed'); return; }
    if (active >= 2) { fail(503, 'MCP capacity reached'); return; }
    active++;
    const chunks: Buffer[] = [];
    let size = 0;
    let server: McpServer | undefined;
    try {
      server = createMcpServer(options);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > (options.maxBodyBytes ?? 1_000_000)) { fail(413, 'payload too large'); return; }
        chunks.push(bytes);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail(400, 'invalid JSON'); return; }
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch { if (!response.headersSent) fail(500, 'MCP request failed'); }
    finally { try { await server?.close(); } finally { active--; } }
  };
}
