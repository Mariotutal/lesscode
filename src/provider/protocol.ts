import type { ChatCompletionResult, ModelClient, ProviderConfig } from './types.js';

/** Operator-selected wire adapter. Repository input cannot choose a protocol or credentials. */
export interface ModelProtocol {
  readonly id: string;
  readonly supportsTools: boolean;
  encode(config: ProviderConfig, request: Parameters<ModelClient['chat']>[0]): { url: string; headers: Record<string, string>; body: unknown };
  decode(value: unknown): ChatCompletionResult;
}

export const openAiChatProtocol: ModelProtocol = {
  id: 'openai-chat-completions', supportsTools: true,
  encode(config, request) {
    return {
      url: `${config.baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: { model: config.model, messages: request.messages, ...(request.tools ? { tools: request.tools, tool_choice: request.toolChoice ?? 'auto' } : {}) },
    };
  },
  decode(value) {
    if (!value || typeof value !== 'object') throw new Error('model response must be an object');
    const root = value as { choices?: { message?: { content?: string | null; tool_calls?: ChatCompletionResult['toolCalls'] }; finish_reason?: string }[]; usage?: ChatCompletionResult['usage']; model?: string };
    const choice = root.choices?.[0];
    if (!choice?.message) throw new Error('model response has no completion message');
    return { content: choice.message.content ?? null, toolCalls: choice.message.tool_calls ?? [], finishReason: choice.finish_reason ?? null, usage: root.usage, model: root.model };
  },
};
