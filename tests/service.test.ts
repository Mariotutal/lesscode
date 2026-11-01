import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as github from "../src/pr/github.js";
import * as execution from "../src/execution/index.js";
import { createHostedRunner } from "../src/service/runner.js";
import { createReviewService, type HostedReviewRunner, type ReviewServiceConfig } from "../src/service/server.js";
import { ReviewJobStore, type ReviewSubmission } from "../src/service/store.js";

const temporary: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), "lc-service-test-")); temporary.push(path); return path; };
const token = "test-service-authentication-token-123456789";
const input: ReviewSubmission = { owner: "Example", repo: "project", prNumber: 7, expectedHeadSha: "a".repeat(40) };
const config = (extra: Partial<ReviewServiceConfig> = {}): ReviewServiceConfig => ({ token, image: "operator/runner:fixed", allowedRepositories: ["Example/project"], dataDirectory: directory(), ...extra });
afterEach(() => { vi.restoreAllMocks(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > until) throw new Error("service state did not settle"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

describe("durable review job store", () => {
  it("deduplicates by immutable identity and prevents a second service owning the same store", () => {
    const path = directory();
    const store = new ReviewJobStore(path);
    try {
      const first = store.create(input);
      expect(first.created).toBe(true);
      expect(store.create({ ...input, owner: "example" })).toMatchObject({ created: false, job: { id: first.job.id } });
      expect(() => new ReviewJobStore(path)).toThrow(/owned/);
      expect(store.get(first.job.id)?.state).toBe("queued");
    } finally { store.close(); }
  });

  it("recovers interrupted work and preserves completed artifacts across a restart", () => {
    const path = directory();
    const original = new ReviewJobStore(path);
    const { job } = original.create(input);
    original.update(job.id, { state: "running", attempts: 1 });
    original.close();
    const recovered = new ReviewJobStore(path);
    expect(recovered.get(job.id)).toMatchObject({ state: "queued", attempts: 1 });
    recovered.update(job.id, { state: "running", attempts: 2 });
    recovered.complete(job.id, { patch: "verified patch", headSha: input.expectedHeadSha });
    recovered.close();
    const restarted = new ReviewJobStore(path);
    try {
      expect(restarted.get(job.id)).toMatchObject({ state: "completed", attempts: 2 });
      expect(restarted.artifact(job.id)).toEqual({ patch: "verified patch", headSha: input.expectedHeadSha });
    } finally { restarted.close(); }
  });

  it("recovers a dead process lock and a durable artifact written before the completion record", () => {
    const path = directory();
    const original = new ReviewJobStore(path);
    const { job } = original.create(input);
    original.update(job.id, { state: "running" });
    original.close();
    writeFileSync(join(path, ".lock"), JSON.stringify({ pid: 2_147_483_647, token: "dead-owner" }));
    writeFileSync(join(path, `${job.id}.artifact.json`), JSON.stringify({ patch: "already persisted" }));
    const recovered = new ReviewJobStore(path);
    try { expect(recovered.get(job.id)?.state).toBe("completed"); expect(recovered.artifact(job.id)).toEqual({ patch: "already persisted" }); }
    finally { recovered.close(); }
  });

  it("bounds the number of records and artifact size", () => {
    const store = new ReviewJobStore(directory(), 1, 64);
    try {
      const { job } = store.create(input);
      expect(() => store.create({ ...input, prNumber: 8 })).toThrow(/storage limit/);
      expect(() => store.complete(job.id, { patch: "x".repeat(100) })).toThrow(/artifact exceeds/);
    } finally { store.close(); }
  });
});

async function start(runner: HostedReviewRunner, extra: Partial<ReviewServiceConfig> = {}) {
  const service = createReviewService(config(extra), { runner });
  const address = await service.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, body?: unknown, authenticated = true) => fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { service, request };
}

describe("authenticated hosted review application", () => {
  it("rejects missing startup policy", () => {
    const runner = async () => ({});
    expect(() => createReviewService(config({ token: "short" }), { runner })).toThrow(/token/);
    expect(() => createReviewService(config({ allowedRepositories: [] }), { runner })).toThrow(/allowlist/);
    expect(() => createReviewService(config({ image: "" }), { runner })).toThrow(/Docker runner image/);
    expect(() => createReviewService(config({ concurrency: 20 }), { runner })).toThrow(/concurrency/);
  });

  it("resumes interrupted jobs on restart without rerunning completed jobs", async () => {
    const dataDirectory = directory();
    const interrupted = new ReviewJobStore(dataDirectory);
    const { job } = interrupted.create(input);
    interrupted.update(job.id, { state: "running", attempts: 1 });
    interrupted.close();
    const runner = vi.fn(async () => ({ patch: "recovered artifact" }));
    const resumed = await start(runner, { dataDirectory });
    await waitFor(() => resumed.service.store.get(job.id)?.state === "completed");
    expect(resumed.service.store.get(job.id)?.attempts).toBe(2);
    await resumed.service.close();
    const second = await start(runner, { dataDirectory });
    try {
      expect(second.service.store.get(job.id)?.state).toBe("completed");
      expect(runner).toHaveBeenCalledTimes(1);
    } finally { await second.service.close(); }
  });

  it("does not resume a repository removed from the operator allowlist", async () => {
    const dataDirectory = directory();
    const old = new ReviewJobStore(dataDirectory);
    const { job } = old.create({ ...input, repo: "removed" });
    old.close();
    const runner = vi.fn(async () => ({}));
    const service = createReviewService(config({ dataDirectory }), { runner });
    try {
      expect(service.store.get(job.id)).toMatchObject({ state: "failed", error: "repository is no longer allowed by the service policy" });
      expect(runner).not.toHaveBeenCalled();
    } finally { await service.close(); }
  });

  it("requires auth for job submission, status and artifact, and rejects local paths, unknown repositories and oversized bodies", async () => {
    const runner = vi.fn(async () => ({ patch: "" }));
    const app = await start(runner, { maxBodyBytes: 512 });
    try {
      expect((await app.request("/reviews", input, false)).status).toBe(401);
      expect((await app.request("/reviews", { ...input, checkout: "/private/checkout" })).status).toBe(400);
      expect((await app.request("/reviews", { ...input, expectedHeadSha: "master" })).status).toBe(400);
      expect((await app.request("/reviews", { ...input, repo: "other" })).status).toBe(403);
      expect((await app.request("/reviews", { ...input, extra: "x".repeat(1000) })).status).toBe(413);
      expect((await app.request(`/reviews/${"b".repeat(64)}`, undefined, false)).status).toBe(401);
      expect((await app.request(`/reviews/${"b".repeat(64)}/artifact`, undefined, false)).status).toBe(401);
      expect(runner).not.toHaveBeenCalled();
    } finally { await app.service.close(); }
  });

  it("runs one job for duplicate submissions and preserves the exact verified artifact", async () => {
    let finish!: (artifact: unknown) => void;
    const runner = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const secret = "model-credential-must-not-be-stored";
    const app = await start(runner, { secrets: [secret] });
    try {
      const response = await app.request("/reviews", input);
      expect(response.status).toBe(202);
      const job = await response.json() as { id: string };
      await waitFor(() => runner.mock.calls.length === 1);
      const duplicate = await app.request("/reviews", input);
      expect(duplicate.status).toBe(200);
      expect((await duplicate.json() as { id: string }).id).toBe(job.id);
      expect((await app.request(`/reviews/${job.id}/artifact`)).status).toBe(409);
      finish({ patch: 'verified source using "Bearer ${token}"', expectedHeadSha: input.expectedHeadSha });
      await waitFor(() => app.service.store.get(job.id)?.state === "completed");
      const artifact = await app.request(`/reviews/${job.id}/artifact`);
      expect(artifact.status).toBe(200);
      expect(await artifact.json()).toEqual({ patch: 'verified source using "Bearer ${token}"', expectedHeadSha: input.expectedHeadSha });
      expect(runner).toHaveBeenCalledTimes(1);
    } finally { await app.service.close(); }
  });

  it("withholds an entire artifact containing a control-plane credential instead of changing its verified patch", async () => {
    const secret = "control-credential-never-an-artifact";
    const app = await start(async () => ({ patch: secret }), { secrets: [secret] });
    try {
      const job = await (await app.request("/reviews", input)).json() as { id: string };
      await waitFor(() => app.service.store.get(job.id)?.state === "failed");
      expect(app.service.store.get(job.id)?.error).toMatch(/artifact withheld/);
      expect((await app.request(`/reviews/${job.id}/artifact`)).status).toBe(409);
    } finally { await app.service.close(); }
  });

  it("bounds waiting jobs and worker concurrency", async () => {
    const releases: (() => void)[] = [];
    let concurrent = 0, maximum = 0;
    const runner: HostedReviewRunner = (_request, signal) => new Promise((resolve, reject) => {
      concurrent++; maximum = Math.max(maximum, concurrent);
      releases.push(() => { concurrent--; resolve({ patch: "" }); });
      signal.addEventListener("abort", () => { concurrent--; reject(new Error("cancelled")); }, { once: true });
    });
    const app = await start(runner, { concurrency: 1, maxQueued: 1 });
    try {
      expect((await app.request("/reviews", input)).status).toBe(202);
      await waitFor(() => releases.length === 1);
      expect((await app.request("/reviews", { ...input, prNumber: 8 })).status).toBe(202);
      expect((await app.request("/reviews", { ...input, prNumber: 9 })).status).toBe(503);
      releases[0]!();
      await waitFor(() => releases.length === 2);
      releases[1]!();
      await waitFor(() => app.service.store.list().every((job) => job.state === "completed"));
      expect(maximum).toBe(1);
    } finally { await app.service.close(); }
  });

  it("records a failed job with redacted error and cancels jobs at their deadline", async () => {
    const secret = "private-token-in-exception";
    const fail = await start(async () => { throw new Error(`failed with ${secret}`); }, { secrets: [secret] });
    try {
      const job = await (await fail.request("/reviews", input)).json() as { id: string };
      await waitFor(() => fail.service.store.get(job.id)?.state === "failed");
      expect(fail.service.store.get(job.id)?.error).toBe("failed with [REDACTED]");
    } finally { await fail.service.close(); }
    const timeout = await start((_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), { jobTimeoutMs: 50 });
    try {
      const job = await (await timeout.request("/reviews", input)).json() as { id: string };
      await waitFor(() => timeout.service.store.get(job.id)?.state === "failed");
      expect(timeout.service.store.get(job.id)?.error).toMatch(/timeout/);
    } finally { await timeout.service.close(); }
  });
});

describe("hosted runner execution policy", () => {
  it("uses a dedicated Docker executor, pins the expected revision, disables publication by default and disposes it", async () => {
    const executor: execution.RepositoryExecutor = { kind: "docker", prepare: vi.fn(async () => {}), run: vi.fn(), runSync: vi.fn(), dispose: vi.fn(async () => {}) };
    vi.spyOn(execution, "createDockerExecutor").mockReturnValue(executor);
    vi.spyOn(github, "createGithubApi").mockReturnValue({ request: vi.fn() });
    const run = vi.spyOn(github, "runGithubPrReview").mockResolvedValue({ verdict: "reviewed" } as github.GithubPrReviewOutcome);
    const runner = createHostedRunner({ githubToken: "github-test", metaApiKey: "meta-test", image: "operator/runner:fixed" });
    await runner(input, new AbortController().signal);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ executor, expectedHeadSha: input.expectedHeadSha, publish: false, offer: "none" }));
    expect(execution.createDockerExecutor).toHaveBeenCalledWith({ image: "operator/runner:fixed" });
    expect(executor.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects a moved PR head before allowing its source to be reviewed", async () => {
    const executor: execution.RepositoryExecutor = { kind: "docker", prepare: vi.fn(async () => {}), run: vi.fn(), runSync: vi.fn(), dispose: vi.fn(async () => {}) };
    vi.spyOn(execution, "createDockerExecutor").mockReturnValue(executor);
    vi.spyOn(github, "createGithubApi").mockReturnValue({ request: async () => ({ status: 200, body: { head: { sha: "b".repeat(40) } } }) });
    vi.spyOn(github, "runGithubPrReview").mockImplementation(async (options) => {
      await options.api.request({ method: "GET", path: `/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}` });
      throw new Error("unreachable review execution");
    });
    const runner = createHostedRunner({ githubToken: "github-test", metaApiKey: "meta-test", image: "operator/runner:fixed" });
    await expect(runner(input, new AbortController().signal)).rejects.toThrow(/head moved/);
    expect(executor.dispose).toHaveBeenCalledTimes(1);
  });
});
