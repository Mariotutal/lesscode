import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpServer, createHttpHandler } from '../src/mcp/server.js';
import type { RunRecord } from '../src/engine/types.js';

describe('MCP SDK interoperability', () => {
  it('supports real authenticated HTTP initialization and discovery, and rejects origins/methods', async () => {
    const token = 'x'.repeat(32);
    const handler = createHttpHandler({ root: process.cwd(), token, runnerImage: 'approved:test' });
    const http = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
    const client = new Client({ name: 'http-test', version: '1' });
    try {
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { authorization: `Bearer ${token}`, origin: 'https://evil.invalid' } })).status).toBe(403);
      expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      expect((await client.listTools()).tools[0]?.name).toBe('review_change');
    } finally { await client.close(); await new Promise<void>(resolve => http.close(() => resolve())); }
  });
  it('negotiates, discovers, validates and returns structured run records', async () => {
    let calls = 0;
    const server = createMcpServer({ root: process.cwd(), trustedLocal: true, run: async () => {
      calls++;
      return { schemaVersion: 1, runId: 'r', state: 'failed', outcome: null, verdict: 'failed', revision: null, execution: { kind: 'trusted-local', policyVersion: 1 }, findings: [], findingIds: [], edits: [], gate: null, verification: { status: 'not-run', treeHash: null }, artifact: null, review: { items: [], markdown: '' }, manifest: {}, audit: {}, failure: { stage: 'resolve', message: 'test failure' } } as unknown as RunRecord;
    } });
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(t => t.name)).toEqual(['review_change']);
      const result = await client.callTool({ name: 'review_change', arguments: { checkout: process.cwd(), base: 'HEAD', intent: ['src/a.ts'] } });
      expect(result.structuredContent).toMatchObject({ verdict: 'failed', revision: null });
      const invalid = await client.callTool({ name: 'review_change', arguments: { checkout: process.cwd(), base: 'HEAD', intent: [123] } });
      expect(invalid.isError).toBe(true);
      const escape = await client.callTool({ name: 'review_change', arguments: { checkout: '/private/tmp', base: 'HEAD', intent: ['a.ts'] } });
      expect(escape.isError).toBe(true);
      expect(calls).toBe(1);
    } finally { await client.close(); await server.close(); }
  });
  it('fails closed for HTTP credentials and trusted host execution', () => {
    expect(() => createHttpHandler({ root: process.cwd(), token: '' })).toThrow(/token/);
    expect(() => createHttpHandler({ root: process.cwd(), token: 'x'.repeat(32), trustedLocal: true })).toThrow(/isolated/);
  });
});
