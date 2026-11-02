import { runReview } from "../engine/run.js";

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

async function handleToolCall(args: any) {
  if (!args?.checkout || !args?.base || !Array.isArray(args?.intent)) throw new Error("checkout, base, intent required");
  // sealed guard: reject traversing outside checkout - gate derives verdict anyway
  for (const p of args.intent) if (p.includes("..")) throw new Error("sealed guard: intent path escapes checkout");
  const record = await runReview({ checkout: args.checkout, base: args.base, intent: args.intent });
  const structuredContent = buildOutput(record);
  return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
}

function handleRequest(msg: any): any | null {
  const { id, method, params } = msg;
  if (method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "lesscode", version: "0.0.0" } } };
  if (method === "notifications/initialized" || method.startsWith("notifications/")) return null;
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: [{ name: TOOL_NAME, description: "Review a change", inputSchema, outputSchema }] } };
  if (method === "tools/call") {
    if (params?.name !== TOOL_NAME) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } };
    return handleToolCall(params.arguments).then(
      (r) => ({ jsonrpc: "2.0", id, result: r }),
      (e: any) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e?.message ?? e) } }),
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
export function createHttpHandler() {
  return async (req: any, res: any) => {
    // require protocol version header
    if (!req.headers["mcp-protocol-version"] && !req.headers["Mcp-Protocol-Version"]) {
      res.writeHead(400).end("Missing Mcp-Protocol-Version");
      return;
    }
    let body = "";
    for await (const c of req) body += c;
    const msg = JSON.parse(body || "{}");
    const result = await handleRequest(msg);
    const resolved = await result;
    if (!resolved) { res.writeHead(202).end(); return; }
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
