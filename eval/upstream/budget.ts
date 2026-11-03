import type { InvocationReceipt } from './contracts.js';

/** Bound each live adapter's transport, including retries, without persisting bodies. */
export function boundedFetch(endpoint: string, receipt: InvocationReceipt, delegate: typeof fetch): typeof fetch {
  return async (url, init) => {
    if (String(url) !== endpoint || typeof init?.body !== 'string') throw new Error('evaluation transport refused unexpected endpoint or body');
    if (++receipt.attempts > receipt.maxRequests || Buffer.byteLength(init.body) > receipt.maxPromptBytes) throw new Error('evaluation request budget exceeded');
    const body = JSON.parse(init.body);
    body.max_tokens = receipt.maxCompletionTokens;
    if (body.tools && body.tool_choice !== 'auto') throw new Error('evaluation requires tool_choice auto');
    const response = await delegate(url, { ...init, body: JSON.stringify(body), redirect: 'error' });
    if (response.ok) {
      const value = await response.clone().json() as { model?: string; usage?: { total_tokens?: number } };
      if (value.model) receipt.responseModels.push(value.model);
      receipt.responseTokens += value.usage?.total_tokens ?? 0;
    }
    return response;
  };
}
