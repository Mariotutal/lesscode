import { describe, it, expect, vi, afterEach } from "vitest";
import { __test__, createHttpHandler } from "../src/mcp/server.js";

vi.mock("../src/engine/run.js", () => ({
  runReview: vi.fn(async () => ({
    verdict:"pass", runId:"r", revision:{}, gate:null, review:{}, artifact:null, manifest:{},
  })),
}));

describe("mcp server", () => {
  afterEach(() => delete process.env.LESSCODE_MCP_TOKEN);
  it("lists tools", async () => {
    const res:any = await __test__.handleRequest({ id:1, method:"tools/list", params:{} });
    expect(res.result.tools[0].name).toBe("review_change");
  });
  it("calls tool", async () => {
    const res:any = await __test__.handleRequest({ id:1, method:"tools/call", params:{ name:"review_change", arguments:{ checkout:"/tmp", base:"main", intent:["a.ts"] } } });
    const out = await res;
    expect(out.result.structuredContent.verdict).toBe("pass");
    expect(out.result.content[0].text).toContain("pass");
  });
  it("http requires protocol version", async () => {
    const h = createHttpHandler();
    const req:any = Object.assign(async function*(){ yield JSON.stringify({ id:1, method:"tools/list" }); }(), { headers:{} });
    let code=0; const res:any={ writeHead(c:number){code=c;}, end(){}};
    await h(req,res); expect(code).toBe(400);
  });
  it("http auth", async () => {
    process.env.LESSCODE_MCP_TOKEN="secret";
    const h = createHttpHandler();
    const req:any = Object.assign(async function*(){ yield "{}"; }(), { headers:{ "mcp-protocol-version":"2025-03-26" } });
    let code=0; const res:any={ writeHead(c:number){code=c;}, end(){}};
    await h(req,res); expect(code).toBe(401);
  });
  it("http body limit", async () => {
    const h = createHttpHandler();
    const big="x".repeat(1_100_000);
    const req:any = Object.assign(async function*(){ yield big; }(), { headers:{ "mcp-protocol-version":"2025-03-26" } });
    let code=0; const res:any={ writeHead(c:number){code=c;}, end(){}};
    await h(req,res); expect(code).toBe(413);
  });
});
