export type ModelRole = "spark" | "wonder";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider?: string;
}

/** Alias kept while callers migrate from the Meta-specific name. */
export type GuestConfig = ProviderConfig;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Minimal dependency injection point so tests can stub the wire. */
export interface ModelClient {
  readonly config: ProviderConfig;
  chat(req: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: "auto";
    signal?: AbortSignal;
  }): Promise<ChatCompletionResult>;
}

/** Back-compat alias. */
export type GuestClient = ModelClient;
