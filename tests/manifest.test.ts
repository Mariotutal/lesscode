import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createGuestClient, ModelTimeoutError } from "../src/classify/client.js";
import { ManifestBuilder, priceUsage, renderRunSummary } from "../src/manifest.js";
import type { GuestClient } from "../src/classify/client.js";
import { simplify } from "../src/simplify/simplify.js";

const exec = promisify(execFile);
const root = process.cwd();
const okBody = JSON.stringify({
  model: "stub-model",
  choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

describe("client retry (LES-26)", () => {
  it("429 then 200 succeeds, with backoff, at most two retries", async () => {
    let calls = 0;
    const delays: number[] = [];
    const client = createGuestClient({
      env: { META_API_KEY: "test-secret" },
      fetchFn: async () => {
        calls++;
        return calls === 1
          ? { ok: false, status: 429, text: async () => "rate limited" }
          : { ok: true, status: 200, text: async () => okBody };
      },
      sleepFn: async (ms) => { delays.push(ms); },
    });
    const r = await client.chat({ messages: [{ role: "user", content: "x" }] });
    expect(r.content).toBe("ok");
    expect(calls).toBe(2);
    expect(delays).toHaveLength(1);
  });

  it("persistent 500 stops after two retries; 400 is not retried", async () => {
    let calls = 0;
    const failing = createGuestClient({
      env: { META_API_KEY: "test" }, sleepFn: async () => {},
      fetchFn: async () => { calls++; return { ok: false, status: 500, text: async () => "boom" }; },
    });
    await expect(failing.chat({ messages: [] })).rejects.toThrow(/Meta API 500/);
    expect(calls).toBe(3);
    calls = 0;
    const bad = createGuestClient({
      env: { META_API_KEY: "test" }, sleepFn: async () => {},
      fetchFn: async () => { calls++; return { ok: false, status: 400, text: async () => "bad" }; },
    });
    await expect(bad.chat({ messages: [] })).rejects.toThrow(/Meta API 400/);
    expect(calls).toBe(1);
  });

  it("a wire that never answers ends with the existing timeout error", async () => {
    const hanging = (_url: string, init: { signal?: AbortSignal }) => new Promise<{ ok: boolean; status: number; text(): Promise<string> }>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const client = createGuestClient({ env: { META_API_KEY: "test" }, fetchFn: hanging as never, timeoutMs: 100 });
    await expect(client.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(ModelTimeoutError);
  });
});

function scripted(sparkFindings: unknown, wonderEdits: unknown): GuestClient {
  return {
    config: { baseUrl: "stub", apiKey: "stub-secret-never-in-manifest", model: "scripted" },
    async chat(req) {
      const tool = req.tools?.[0]?.function.name ?? "";
      const payload = tool === "report_findings" ? { findings: sparkFindings } : { edits: wonderEdits };
      return {
        content: null,
        toolCalls: [{ id: "c1", type: "function" as const, function: { name: tool, arguments: JSON.stringify(payload) } }],
        finishReason: "tool_calls",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    },
  } as GuestClient;
}

describe("cost passthrough (LES-54)", () => {
  it("derives cost from usage with the default table and with pricing overrides", () => {
    expect(priceUsage("muse-spark-1.3", { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 })).toEqual({ inputUsd: 0.5, outputUsd: 1.5, totalUsd: 2 });
    expect(priceUsage("acme/model", { prompt_tokens: 500_000, completion_tokens: 0, total_tokens: 500_000 }, { "acme/model": { inputPerMtok: 4 } })).toEqual({ inputUsd: 2, outputUsd: 0, totalUsd: 2 });
    expect(priceUsage("unknown/model", { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 })).toBeUndefined();
    expect(priceUsage("muse-spark-1.3", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toBeUndefined();
  });
  it("manifest carries responseModels + cost, and renderRunSummary prints cost only when present", () => {
    const b = new ManifestBuilder(); b.sparkModel = "muse-spark-1.3"; b.wonderModel = "acme/wonder";
    b.setPricing("wonder", { "acme/wonder": { inputPerMtok: 2, outputPerMtok: 4 } });
    b.recordResponse("spark", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, "muse-spark-1.3");
    b.recordResponse("wonder", { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 });
    const m = b.build();
    expect(m.responseModels).toEqual({ spark: "muse-spark-1.3" });
    expect(m.cost?.totalUsd).toBeCloseTo(100 / 1e6 * 0.5 + 50 / 1e6 * 1.5 + 200 / 1e6 * 2 + 100 / 1e6 * 4, 12);
    expect(m.cost?.byRole.wonder).toBeDefined();
    const withCost = renderRunSummary({ verdict: "accepted", findingsKept: [], findingsDropped: [], editsKept: [], editsDropped: [], manifest: m });
    expect(withCost).toContain("Cost: $");
    const bare = new ManifestBuilder(); bare.sparkModel = "unknown/x";
    const m2 = bare.build(); expect(m2.cost).toBeUndefined();
    expect(renderRunSummary({ verdict: "reviewed", findingsKept: [], findingsDropped: [], editsKept: [], editsDropped: [], manifest: m2 })).not.toContain("Cost:");
  });
});

describe("run manifest (LES-26)", () => {
  it("scripted simplify run prints a manifest naming both models, phases summing to the run", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lc-manifest-"));
    const dir = join(tmp, "f");
    await exec("bash", ["fixtures/scripts/materialize.sh", "1", dir], { cwd: root });
    await exec("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    await exec("git", ["checkout", "-q", "bloated-pr"], { cwd: dir });
    void readFileSync;
    const cite = (file: string, a: number, b: number) => ({ file, startLine: a, endLine: b });
    const spark = [
      { category: "single-use-abstraction", file: "src/userApiClient.ts", citations: [cite("src/userApiClient.ts", 1, 6)], rationale: "single-use" },
    ];
    const wonder = [{ findingIndex: 0, action: "inline", newFiles: [], deleteFiles: [], rationale: "inline" }];
    const sparkClient = { ...scripted(spark, wonder), config: { baseUrl: "stub", apiKey: "s", model: "muse-spark-1.3" } } as GuestClient;
    const wonderClient = { ...scripted(spark, wonder), config: { baseUrl: "stub", apiKey: "s", model: "muse-wonder-1.0" } } as GuestClient;
    const r = await simplify({
      checkout: dir, base: "base",
      intent: ["src/userFetcher.ts", "src/userApiClient.ts", "src/userRepository.ts", "src/userService.ts"],
      sparkClient, wonderClient,
    });
    const m = r.manifest;
    expect(m.models).toEqual({ spark: "muse-spark-1.3", wonder: "muse-wonder-1.0" });
    expect(m.callsByModel).toEqual({ spark: 1, wonder: 1 });
    expect(m.modelCalls).toBe(2);
    expect(m.usage.total_tokens).toBe(30);
    const sum = Object.values(m.phasesMs).reduce((sum, ms) => sum + ms, 0);
    expect(Math.abs(sum - m.totalMs)).toBeLessThan(1);
    for (const v of Object.values(m.phasesMs)) expect(v).toBeGreaterThanOrEqual(0);
    expect(m.promptHashes).toHaveLength(2);
    for (const h of m.promptHashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Credential and prompt text never appear in manifest or summary.
    expect(JSON.stringify(m)).not.toContain("stub-secret");
    expect(r.summary).toContain("Verdict:");
    expect(r.summary).toContain("muse-spark-1.3");
    expect(r.summary).toContain("muse-wonder-1.0");
    expect(JSON.stringify(r)).not.toContain("Classify the findings in this checkout");
  }, 300_000);
});
