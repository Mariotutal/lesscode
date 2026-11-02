import { expect, it } from 'vitest';
import { createRemoteRunner } from '../src/service/remote.js';
import { createModelClient } from '../src/provider/factory.js';
import type { ModelProtocol } from '../src/provider/protocol.js';

it('delegates immutable identity, polls and returns the artifact without forwarding control secrets', async () => {
  const requests: { url: string; body?: string }[] = [];
  const id = 'a'.repeat(64);
  const runner = createRemoteRunner({ url: 'https://worker.example', token: 'x'.repeat(32), pollMs: 1, fetchFn: async (url, init) => {
    requests.push({ url: String(url), body: init?.body as string | undefined });
    expect(init?.redirect).toBe('error');
    const body = String(url).endsWith('/artifact') ? { result: 'verified' } : { id, state: requests.length === 1 ? 'running' : 'completed' };
    return new Response(JSON.stringify(body));
  } });
  expect(await runner({ owner: 'Example', repo: 'app', prNumber: 1, expectedHeadSha: 'b'.repeat(40) }, new AbortController().signal)).toEqual({ result: 'verified' });
  expect(JSON.parse(requests[0]!.body!)).toEqual({ owner: 'Example', repo: 'app', prNumber: 1, expectedHeadSha: 'b'.repeat(40) });
  expect(() => createRemoteRunner({ url: 'http://remote.example', token: 'x'.repeat(32) })).toThrow(/HTTPS/);
});

it('supports operator-selected non-OpenAI wire adapters and rejects missing tool capability', async () => {
  const protocol: ModelProtocol = {
    id: 'test-native', supportsTools: false,
    encode: () => ({ url: 'https://native.example/messages', headers: { 'x-api-key': 'fake' }, body: { prompt: 'hello' } }),
    decode: () => ({ content: 'native reply', toolCalls: [], finishReason: 'stop' }),
  };
  let called = 0;
  const client = createModelClient('spark', { config: { apiKey: 'fake', baseUrl: 'https://native.example', model: 'test' }, protocol, fetchFn: async (url) => {
    called++; expect(url).toBe('https://native.example/messages'); return { ok: true, status: 200, text: async () => '{}' };
  } });
  expect((await client.chat({ messages: [] })).content).toBe('native reply');
  await expect(client.chat({ messages: [], tools: [{ type: 'function', function: { name: 't', description: '', parameters: {} } }] })).rejects.toThrow(/does not support tools/);
  expect(called).toBe(1);
});
