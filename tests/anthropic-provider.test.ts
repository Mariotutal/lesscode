import { describe, expect, it } from "vitest";
import { createModelClient, resolveProviderConfig } from "../src/provider/factory.js";
import { decodeAnthropicMessage, encodeAnthropicRequest } from "../src/provider/anthropic.js";
import type { ProviderConfig, ToolDefinition } from "../src/provider/types.js";

const tool: ToolDefinition = { type: "function", function: { name: "report_findings", description: "d", parameters: { type: "object", properties: {} } } };
const config: ProviderConfig = { baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-secret-key-123456", model: "claude-opus-5-5", protocol: "anthropic-messages" };

function sse(events: object[]): Response {
  const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const toolStream = () => sse([
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "report_findings", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"findings\":[]}" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
]);

const apiError = (status: number, message: string) => new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), { status, headers: { "content-type": "application/json" } });

describe("Anthropic Messages protocol selection", () => {
  it("LESSCODE_PROTOCOL selects the first-party endpoint and default model", () => {
    const cfg = resolveProviderConfig("wonder", { LESSCODE_API_KEY: "k", LESSCODE_PROTOCOL: "anthropic-messages" });
    expect(cfg).toMatchObject({ protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" });
  });
  it("per-role protocol and effort beat shared values", () => {
    const env = { LESSCODE_API_KEY: "k", LESSCODE_PROTOCOL: "openai-chat-completions", LESSCODE_SPARK_PROTOCOL: "anthropic-messages", LESSCODE_EFFORT: "medium", LESSCODE_SPARK_EFFORT: "low" };
    expect(resolveProviderConfig("spark", env)).toMatchObject({ protocol: "anthropic-messages", effort: "low" });
    expect(resolveProviderConfig("wonder", env)).toMatchObject({ protocol: "openai-chat-completions", effort: "medium", baseUrl: "https://api.meta.ai/v1" });
  });
  it("rejects unknown protocol and effort values", () => {
    expect(() => resolveProviderConfig("spark", { LESSCODE_API_KEY: "k", LESSCODE_PROTOCOL: "gemini" })).toThrow(/unknown model protocol/);
    expect(() => resolveProviderConfig("spark", { LESSCODE_API_KEY: "k", LESSCODE_EFFORT: "huge" })).toThrow(/unknown effort/);
  });
  it("ANTHROPIC_API_KEY is not an automatic alias", () => {
    expect(() => resolveProviderConfig("spark", { ANTHROPIC_API_KEY: "a", LESSCODE_PROTOCOL: "anthropic-messages" })).toThrow(/no model API key/);
  });
  it("only a trusted local file can choose the protocol", () => {
    const fileConfig = { version: 1 as const, providers: { a: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY", protocol: "anthropic-messages" as const } }, models: { spark: { provider: "a", model: "claude-sonnet-5-5" } } };
    const env = { ANTHROPIC_API_KEY: "a", LESSCODE_API_KEY: "k" };
    expect(resolveProviderConfig("spark", env, { fileConfig, trusted: true })).toMatchObject({ protocol: "anthropic-messages", model: "claude-sonnet-5-5" });
    expect(resolveProviderConfig("spark", env, { fileConfig, trusted: false }).protocol).toBeUndefined();
  });
  it("a trusted policy provider carries its protocol to the checkout's alias", () => {
    const trustedPolicy = { version: 1 as const, providers: { a: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "OP_KEY", protocol: "anthropic-messages" as const } }, models: { wonder: { provider: "a", model: "claude-opus-5-5" } } };
    expect(resolveProviderConfig("wonder", { OP_KEY: "x", LESSCODE_PROTOCOL: "openai-chat-completions" }, { trustedPolicy, fileConfig: null })).toMatchObject({ protocol: "anthropic-messages", apiKey: "x" });
  });
});

describe("Anthropic Messages encoding", () => {
  it("maps system, tools, tool turns, effort and the first-party fallback", () => {
    const body = encodeAnthropicRequest(config, "spark", {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "report_findings", arguments: "{\"a\":1}" } }] },
        { role: "tool", tool_call_id: "c1", content: "done" },
        { role: "user", content: "again" },
      ],
      tools: [tool],
    });
    expect(body).toMatchObject({ system: "sys", tool_choice: { type: "auto" }, output_config: { effort: "low" }, fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(body.tools).toEqual([{ name: "report_findings", description: "d", input_schema: { type: "object", properties: {} } }]);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "report_findings", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }, { type: "text", text: "again" }] },
    ]);
  });
  it("sends no fallback to other endpoints and honours configured effort", () => {
    const body = encodeAnthropicRequest({ ...config, baseUrl: "https://gateway.example", effort: "max" }, "wonder", { messages: [{ role: "user", content: "x" }] });
    expect(body).not.toHaveProperty("fallbacks");
    expect(body).not.toHaveProperty("betas");
    expect(body.output_config).toEqual({ effort: "max" });
  });
  it("decodes tool calls, usage and finish reason; refusals throw", () => {
    const base = { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_sequence: null, stop_details: null, container: null, context_management: null };
    const result = decodeAnthropicMessage({ ...base, stop_reason: "tool_use", content: [{ type: "text", text: "ok", citations: null }, { type: "tool_use", id: "t", name: "n", input: { b: 2 } }], usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: null } } as never);
    expect(result).toMatchObject({ content: "ok", finishReason: "tool_calls", model: "claude-opus-5-5", usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } });
    expect(result.toolCalls).toEqual([{ id: "t", type: "function", function: { name: "n", arguments: "{\"b\":2}" } }]);
    expect(() => decodeAnthropicMessage({ ...base, stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null }, content: [], usage: { input_tokens: 1, output_tokens: 0 } } as never)).toThrow(/refused the request \(cyber\)/);
  });
});

describe("Anthropic Messages client transport", () => {
  const client = (sdkFetch: typeof fetch, sleeps: number[] = []) =>
    createModelClient("spark", { config, sdkFetch, retryBackoffMs: 1, sleepFn: async (ms) => { sleeps.push(ms); } });

  it("streams a tool call through the shared ModelClient seam without following redirects", async () => {
    const seen: { url: string; redirect?: string }[] = [];
    const res = await client(async (url, init) => { seen.push({ url: String(url), redirect: init?.redirect }); return toolStream(); })
      .chat({ messages: [{ role: "user", content: "x" }], tools: [tool], toolChoice: "auto" });
    expect(res.toolCalls.map((c) => c.function)).toEqual([{ name: "report_findings", arguments: "{\"findings\":[]}" }]);
    expect(res.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5 });
    expect(seen).toEqual([{ url: expect.stringMatching(/^https:\/\/api\.anthropic\.com\/v1\/messages/), redirect: "error" }]);
  });
  it("retries 429/5xx at most twice", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const res = await client(async () => (++calls < 3 ? apiError(calls === 1 ? 429 : 503, "busy") : toolStream()), sleeps).chat({ messages: [{ role: "user", content: "x" }] });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1, 2]);
    expect(res.finishReason).toBe("tool_calls");
    calls = 0;
    await expect(client(async () => { calls++; return apiError(500, "down"); }).chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/model API 500/);
    expect(calls).toBe(3);
  });
  it("does not retry other statuses and redacts the key from errors", async () => {
    let calls = 0;
    const err = await client(async () => { calls++; return apiError(408, `bad key ${config.apiKey}`); }).chat({ messages: [{ role: "user", content: "x" }] }).catch((e: Error) => e);
    expect(calls).toBe(1);
    expect(String(err)).toMatch(/model API 408/);
    expect(String(err)).not.toContain(config.apiKey);
  });
});
