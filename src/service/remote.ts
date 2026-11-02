import type { HostedReviewRunner } from './server.js';

/** API host delegates execution to an operator-owned worker; it holds no model/GitHub keys. */
export function createRemoteRunner(options: { url: string; token: string; pollMs?: number; fetchFn?: typeof fetch }): HostedReviewRunner {
  const url = new URL(options.url);
  if (url.username || url.password || url.search || url.hash || !(['https:'].includes(url.protocol) || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('worker URL requires HTTPS (HTTP allowed only on loopback) and no URL credentials');
  if (options.token.length < 32) throw new Error('worker token must contain at least 32 characters');
  const base = url.href.replace(/\/$/, '');
  const request = options.fetchFn ?? fetch;
  return async (input, signal) => {
    const call = async (path: string, body?: unknown) => {
      const response = await request(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal, headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error(`worker request failed (${response.status})`);
      return await response.json() as Record<string, unknown>;
    };
    const job = await call('/reviews', input);
    if (typeof job.id !== 'string' || !/^[a-f0-9]{64}$/.test(job.id)) throw new Error('worker returned invalid job identity');
    let current = job;
    while (current.state !== 'completed') {
      signal.throwIfAborted();
      if (current.state === 'failed') throw new Error('worker review failed');
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, options.pollMs ?? 1000);
        signal.addEventListener('abort', abort, { once: true });
      });
      current = await call(`/reviews/${job.id}`);
    }
    return call(`/reviews/${job.id}/artifact`);
  };
}
