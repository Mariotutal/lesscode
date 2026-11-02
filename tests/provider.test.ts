import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelClient, modelEnvAvailable, resetDeprecationWarnings, resolveProviderConfig } from "../src/provider/factory.js";
import { clearLesscodeConfigCache, findLesscodeConfigPath, loadLesscodeConfig, redactSecrets } from "../src/provider/configFile.js";

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

describe(".lesscode.json config file (LES-53)", () => {
  let dir = "";
  const cfg = {
    $schema: "https://lesscode.dev/schemas/lesscode.schema.json", version: 1,
    providers: {
      meta: { baseUrl: "https://api.meta.ai/v1", apiKeyEnv: "META_API_KEY" },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1/", apiKeyEnv: "OPENROUTER_API_KEY" },
    },
    models: { spark: { provider: "meta", model: "muse-spark-1.3" }, wonder: { provider: "openrouter", model: "anthropic/claude-sonnet-4" } },
    pricing: { "anthropic/claude-sonnet-4": { inputPerMtok: 3, outputPerMtok: 15 } },
  };
  const writeCfg = (d: string, c: unknown) => { mkdirSync(d, { recursive: true }); writeFileSync(join(d, ".lesscode.json"), JSON.stringify(c)); clearLesscodeConfigCache(); };

  it("repo pins spark@meta and wonder@openrouter without LESSCODE_* env", () => {
    dir = mkdtempSync(join(tmpdir(), "lc53-")); writeCfg(dir, cfg);
    const env = { META_API_KEY: "mk", OPENROUTER_API_KEY: "ok" };
    expect(resolveProviderConfig("spark", env, { cwd: dir })).toMatchObject({ provider: "meta", baseUrl: "https://api.meta.ai/v1", apiKey: "mk", model: "muse-spark-1.3" });
    const w = resolveProviderConfig("wonder", env, { cwd: dir });
    expect(w).toMatchObject({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "ok", model: "anthropic/claude-sonnet-4" });
    expect(w.pricing?.["anthropic/claude-sonnet-4"]).toEqual({ inputPerMtok: 3, outputPerMtok: 15 });
    expect(modelEnvAvailable(env, dir)).toBe(true);
  });
  it("found upward from a nested dir; cached until cleared", () => {
    const nested = join(dir, "a/b"); mkdirSync(nested, { recursive: true });
    expect(findLesscodeConfigPath(nested)).toBe(join(dir, ".lesscode.json"));
    expect(loadLesscodeConfig(nested).config?.version).toBe(1);
    writeFileSync(join(dir, ".lesscode.json"), JSON.stringify({ ...cfg, version: 1 }));
    expect(loadLesscodeConfig(nested).config).toBe(loadLesscodeConfig(nested).config); // same cached object
  });
  it("env overrides file; explicit arg overrides env", () => {
    const env = { META_API_KEY: "mk", OPENROUTER_API_KEY: "ok", LESSCODE_WONDER_MODEL: "env/wonder", LESSCODE_API_BASE_URL: "https://env.example/v1" };
    // LESSCODE_API_BASE_URL is shared-env and beats the file's per-provider baseUrl
    // File apiKeyEnv beats deprecated META_API_KEY alias; canonical LESSCODE_* beats file.
    expect(resolveProviderConfig("wonder", env, { cwd: dir })).toMatchObject({ model: "env/wonder", baseUrl: "https://env.example/v1", apiKey: "ok" });
    expect(resolveProviderConfig("wonder", { ...env, LESSCODE_API_KEY: "lk" }, { cwd: dir }).apiKey).toBe("lk");
    expect(resolveProviderConfig("wonder", env, { cwd: dir, explicit: { model: "arg/model", baseUrl: "https://arg.example/v1", apiKey: "ak" } }))
      .toMatchObject({ model: "arg/model", baseUrl: "https://arg.example/v1", apiKey: "ak" });
    expect(resolveProviderConfig("spark", {}, { fileConfig: cfg as never, explicit: { apiKey: "x" } })).toMatchObject({ model: "muse-spark-1.3" });
  });
  it("rejects literal apiKey, bad version, unknown model provider; errors carry no secrets", () => {
    const bad = mkdtempSync(join(tmpdir(), "lc53bad-"));
    writeCfg(bad, { version: 1, providers: { p: { baseUrl: "https://x/v1", apiKeyEnv: "K", apiKey: "sk-supersecret123" } } });
    expect(() => loadLesscodeConfig(bad, { noCache: true })).toThrow(/invalid/);
    try { loadLesscodeConfig(bad, { noCache: true }); } catch (e) { expect(String(e)).not.toContain("supersecret"); }
    writeCfg(bad, { version: 2 }); expect(() => loadLesscodeConfig(bad, { noCache: true })).toThrow(/invalid/);
    writeCfg(bad, { version: 1, models: { spark: { provider: "nope", model: "m" } } });
    expect(() => resolveProviderConfig("spark", { K: "k" }, { cwd: bad })).toThrow(/not defined in providers/);
  });
  it("missing file falls back to defaults; secret redaction masks env values", () => {
    const empty = mkdtempSync(join(tmpdir(), "lc53empty-")); clearLesscodeConfigCache();
    expect(loadLesscodeConfig(empty)).toEqual({ path: null, config: null });
    expect(resolveProviderConfig("spark", { LESSCODE_API_KEY: "k" }, { cwd: empty })).toMatchObject({ model: "muse-spark-1.3", baseUrl: "https://api.meta.ai/v1" });
    expect(redactSecrets("key=hunter2secret ok", { LESSCODE_API_KEY: "hunter2secret" })).toBe("key=[redacted] ok");
    expect(redactSecrets("Authorization: Bearer abc.def-123")).toContain("Bearer [redacted]");
  });
  it("never reads a config inside sealed/", () => {
    const root = mkdtempSync(join(tmpdir(), "lc53sealed-"));
    writeCfg(join(root, "fixtures/1/sealed"), cfg);
    clearLesscodeConfigCache();
    expect(findLesscodeConfigPath(join(root, "fixtures/1/sealed"))).toBeNull();
    expect(loadLesscodeConfig(join(root, "fixtures/1/sealed")).config).toBeNull();
    expect(() => readdirSync(join(root, "fixtures"))).not.toThrow();
  });
});
