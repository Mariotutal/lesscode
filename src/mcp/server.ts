import { runReview } from "../engine/run.js";

type JsonObject = Record<string, unknown>;
type RpcResponse = JsonObject;
type RpcResult = RpcResponse | Promise<RpcResponse | null> | null;
type HttpRequest = AsyncIterable<string | Buffer> & { headers?: Record<string, unknown> };
type HttpResponse = { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void };

const TOOL_NAME = "review_change";

const inputSchema = {
  type: "object",
  required: ["checkout", "base", "intent"],
  properties: {
    checkout: { type: "string" },
    base: { type: "string" },
    intent: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  required: ["verdict", "runId", "revision", "gate", "review", "artifact", "manifest"],
  properties: {
    verdict: { type: "string" },
    runId: { type: "string" },
    revision: { type: "object" },
    gate: { type: ["object", "null"] },
    review: { type: "object" },
    artifact: { type: ["object", "null"] },
    manifest: { type: "object" },
  },
} as const;

function buildOutput(record: Awaited<ReturnType<typeof runReview>>) {
  return {
    verdict: record.verdict,
    runId: record.runId,
    revision: record.revision,
    gate: record.gate,
    review: record.review,
    artifact: record.artifact,
    manifest: record.manifest,
  };
}

async function handleToolCall(args: unknown) {
  const input = args as { checkout?: unknown; base?: unknown; intent?: unknown };
  if (typeof input?.checkout !== "string" || typeof input.base !== "string" || !Array.isArray(input.intent)) throw new Error("checkout, base, intent required");
  // sealed guard: reject traversing outside checkout - gate derives verdict anyway
  for (const p of input.intent) if (typeof p === "string" && p.includes("..")) throw new Error("sealed guard: intent path escapes checkout");
  const record = await runReview({ checkout: input.checkout, base: input.base, intent: input.intent.filter((p): p is string => typeof p === "string") });
  const structuredContent = buildOutput(record);
  return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
}

function handleRequest(msg: unknown): RpcResult {
  const { id, method, params } = msg as { id?: unknown; method?: string; params?: JsonObject };
  if (!method) return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
  if (method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "lesscode", version: "0.0.0" } } };
  if (method === "notifications/initialized" || method.startsWith("notifications/")) return null;
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: [{ name: TOOL_NAME, description: "Review a change", inputSchema, outputSchema }] } };
  if (method === "tools/call") {
    if (params?.name !== TOOL_NAME) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } };
    return handleToolCall(params.arguments).then(
      (r) => ({ jsonrpc: "2.0", id, result: r }),
      (e: unknown) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }),
    );
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } };
}

// stdio transport
export async function startStdio() {
  let buf = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const res = await handleRequest(msg);
      if (res) {
        const out = await res;
        process.stdout.write(JSON.stringify(out) + "\n");
      }
    }
  }
}

// Streamable HTTP via mcp-proxy pattern: single POST endpoint, Mcp-Protocol-Version header, no session-id
const MAX_BODY = 1_000_000;

function header(headers: Record<string, unknown> | undefined, name: string): string {
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === wanted)?.[1];
  return Array.isArray(entry) ? String(entry[0] ?? "") : String(entry ?? "");
}

export function createHttpHandler() {
  return async (req: HttpRequest, res: HttpResponse) => {
    // optional bearer auth if LESSCODE_MCP_TOKEN set
    const token = process.env.LESSCODE_MCP_TOKEN;
    if (token) {
      const auth = header(req.headers, "authorization");
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
    }
    // require protocol version header
    if (!header(req.headers, "mcp-protocol-version")) {
      res.writeHead(400);
      res.end("Missing Mcp-Protocol-Version");
      return;
    }
    let body = "";
    let size = 0;
    for await (const c of req) {
      const chunk = typeof c === "string" ? c : Buffer.from(c);
      body += typeof chunk === "string" ? chunk : chunk.toString();
      size += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (size > MAX_BODY) {
        res.writeHead(413);
        res.end("Payload too large");
        return;
      }
    }
    let msg: unknown;
    try {
      msg = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }
    const result = await handleRequest(msg);
    const resolved = await result;
    if (!resolved) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Mcp-Protocol-Version": "2025-03-26" });
    res.end(JSON.stringify(resolved));
  };
}

export const __test__ = { handleRequest, handleToolCall, buildOutput };

// CLI entry
const mode = process.argv[2];
if (mode === "--stdio") startStdio();
else if (mode === "--http") {
  const { createServer } = await import("node:http");
  const port = Number(process.env.PORT ?? 3000);
  createServer(createHttpHandler()).listen(port, () => console.log(`MCP HTTP on ${port}`));
}
