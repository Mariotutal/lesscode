import { describe, expect, it } from "vitest";
import { createModelClient, resetDeprecationWarnings, resolveProviderConfig } from "../src/provider/factory.js";

const okBody = JSON.stringify({ model: "m", choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }] });

describe("provider factory (LES-52)", () => {
  it("LESSCODE_API_KEY alone drives both roles with defaults", () => {
    const env = { LESSCODE_API_KEY: "k" };
    expect(resolveProviderConfig("spark", env)).toMatchObject({ apiKey: "k", baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.3" });
    expect(resolveProviderConfig("wonder", env)).toMatchObject({ apiKey: "k", model: "muse-wonder-1.0" });
  });
  it("LESSCODE_* beats META_*; per-role beats shared", () => {
    const cfg = resolveProviderConfig("wonder", {
      LESSCODE_API_KEY: "shared", LESSCODE_WONDER_API_KEY: "wk", LESSCODE_API_BASE_URL: "https://openrouter.ai/api/v1/",
      LESSCODE_WONDER_MODEL: "x/wonder", META_API_KEY: "meta", META_MODEL: "mm", META_API_BASE_URL: "https://meta.example/v1",
    }, { warn: () => {} });
    expect(cfg).toMatchObject({ apiKey: "wk", baseUrl: "https://openrouter.ai/api/v1", model: "x/wonder" });
  });
  it("deprecated META_* aliases still work and warn", () => {
    resetDeprecationWarnings();
    const warns: string[] = [];
    const cfg = resolveProviderConfig("spark", { META_API_KEY: "meta", META_MODEL: "mm" }, { warn: (m) => warns.push(m) });
    expect(cfg).toMatchObject({ apiKey: "meta", model: "mm" });
    expect(warns.join(" ")).toContain("META_API_KEY");
    expect(warns.join(" ")).toContain("META_MODEL");
  });
  it("MODEL_API_KEY alias works; missing key throws naming LESSCODE_API_KEY", () => {
    expect(resolveProviderConfig("spark", { MODEL_API_KEY: "k" }, { warn: () => {} }).apiKey).toBe("k");
    expect(() => resolveProviderConfig("spark", {})).toThrow(/LESSCODE_API_KEY/);
  });
  it("createModelClient dispatches to configured baseUrl/model with tool_choice auto", async () => {
    let url = "", body = "";
    const client = createModelClient("wonder", {
      env: { LESSCODE_API_KEY: "k", LESSCODE_API_BASE_URL: "https://example.test/v1", LESSCODE_WONDER_MODEL: "w1" },
      fetchFn: async (u, init) => { url = u; body = init.body; return { ok: true, status: 200, text: async () => okBody }; },
    });
    const r = await client.chat({ messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "t", description: "", parameters: {} } }] });
    expect(r.content).toBe("ok");
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(JSON.parse(body)).toMatchObject({ model: "w1", tool_choice: "auto" });
  });
});
