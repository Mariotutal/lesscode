import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ReviewJobStore, StoreFullError, type ReviewJob, type ReviewSubmission } from "./store.js";

export interface ReviewServiceConfig {
  token: string;
  allowedRepositories: string[];
  image: string;
  dataDirectory: string;
  concurrency?: number;
  maxQueued?: number;
  maxJobs?: number;
  maxBodyBytes?: number;
  maxArtifactBytes?: number;
  jobTimeoutMs?: number;
  secrets?: string[];
}

export type HostedReviewRunner = (request: ReviewSubmission, signal: AbortSignal) => Promise<unknown>;
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function bounded(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) throw new Error(`invalid ${label}`);
  return selected;
}

function submission(value: unknown): ReviewSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "body must be a GitHub review request");
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !["owner", "repo", "prNumber", "expectedHeadSha"].includes(key))) throw new HttpError(400, "unknown review request field; local paths and execution settings are not accepted");
  const { owner, repo, prNumber, expectedHeadSha } = fields;
  if (typeof owner !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner)
    || typeof repo !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo) || repo === "." || repo === ".."
    || !Number.isSafeInteger(prNumber) || (prNumber as number) < 1 || (prNumber as number) > 2_147_483_647
    || typeof expectedHeadSha !== "string" || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(expectedHeadSha)) {
    throw new HttpError(400, "owner, repo, positive prNumber, and immutable expectedHeadSha are required");
  }
  return { owner, repo, prNumber: prNumber as number, expectedHeadSha: expectedHeadSha.toLowerCase() };
}

async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new HttpError(415, "application/json is required");
  if (Number(request.headers["content-length"] ?? 0) > limit) throw new HttpError(413, "request body exceeds configured limit");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Buffer);
    size += bytes.length;
    if (size > limit) throw new HttpError(413, "request body exceeds configured limit");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "request body is not valid JSON"); }
}

/** Authenticated, bounded single-process application adapter; the review engine remains shared with the CLI. */
export function createReviewService(config: ReviewServiceConfig, dependencies: { runner: HostedReviewRunner }) {
  if (config.token.length < 32) throw new Error("service token must contain at least 32 characters");
  if (!config.image.trim()) throw new Error("service requires an explicit Docker runner image");
  const allowed = new Set(config.allowedRepositories.map((repo) => repo.toLowerCase()));
  if (!allowed.size || [...allowed].some((repo) => !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(repo))) throw new Error("service requires a nonempty owner/repo allowlist");
  const concurrency = bounded(config.concurrency, 1, 4, "concurrency");
  const maxQueued = bounded(config.maxQueued, 50, 1000, "queue limit");
  const maxJobs = bounded(config.maxJobs, 1000, 10_000, "job storage limit");
  const maxBodyBytes = bounded(config.maxBodyBytes, 16_384, 65_536, "body size limit");
  const maxArtifactBytes = bounded(config.maxArtifactBytes, 4 * 1024 * 1024, 64 * 1024 * 1024, "artifact size limit");
  const timeoutMs = bounded(config.jobTimeoutMs, 900_000, 3_600_000, "job timeout");
  const store = new ReviewJobStore(config.dataDirectory, maxJobs, maxArtifactBytes);
  const queued = store.list().filter((job) => job.state === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const queue: string[] = [];
  for (const job of queued) {
    if (allowed.has(`${job.request.owner}/${job.request.repo}`.toLowerCase())) queue.push(job.id);
    else store.update(job.id, { state: "failed", error: "repository is no longer allowed by the service policy" });
  }
  if (queue.length > maxQueued) { store.close(); throw new Error("recovered queue exceeds configured queue limit"); }
  const active = new Map<string, { controller: AbortController; finished: Promise<void> }>();
  const secretValues = [config.token, ...config.secrets ?? []].filter(Boolean);
  const redact = (value: string) => secretValues.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value).replace(/(?:Bearer|Basic)\s+[^\s"']+/gi, "[REDACTED AUTHORIZATION]");
  const credentialSafeArtifact = (value: unknown): unknown => {
    // Never redact a verified patch in place: that would invalidate its proof/hash.
    // Withhold the whole artifact if control-plane credentials somehow reached it.
    const text = JSON.stringify(value, (key, item: unknown) => {
      if (secretValues.some((secret) => key.includes(secret) || (typeof item === "string" && item.includes(secret)))) throw new Error("review artifact contains a control-plane credential; artifact withheld");
      return item;
    });
    return JSON.parse(text);
  };
  let stopped = false;

  const execute = async (job: ReviewJob, controller: AbortController): Promise<void> => {
    const timer = setTimeout(() => controller.abort(new Error("review exceeded configured job timeout")), timeoutMs);
    try {
      const artifact = await dependencies.runner(job.request, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      store.complete(job.id, credentialSafeArtifact(artifact));
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 2000);
      store.update(job.id, { state: stopped && controller.signal.aborted ? "queued" : "failed", error: message });
    } finally { clearTimeout(timer); }
  };

  const pump = () => {
    while (!stopped && active.size < concurrency && queue.length) {
      const id = queue.shift()!;
      const job = store.get(id)!;
      store.update(id, { state: "running", attempts: job.attempts + 1, error: undefined });
      const controller = new AbortController();
      const finished = Promise.resolve().then(() => execute(job, controller)).finally(() => { active.delete(id); pump(); }).catch(() => { stopped = true; });
      active.set(id, { controller, finished });
    }
  };

  const respond = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(JSON.stringify(value));
  };
  const authenticate = (request: IncomingMessage) => {
    const actual = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${config.token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 10_000, headersTimeout: 10_000 }, (request, response) => {
    void (async () => {
      if (!authenticate(request)) throw new HttpError(401, "authentication required");
      if (stopped) throw new HttpError(503, "service is stopping");
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/reviews" && request.method === "POST") {
        const input = submission(await readBody(request, maxBodyBytes));
        if (!allowed.has(`${input.owner}/${input.repo}`.toLowerCase())) throw new HttpError(403, "repository is not allowed");
        const prior = store.find(input);
        if (prior) { respond(response, 200, prior); return; }
        if (queue.length >= maxQueued) throw new HttpError(503, "review queue is full");
        const { job } = store.create(input);
        queue.push(job.id);
        respond(response, 202, job);
        pump();
        return;
      }
      const match = /^\/reviews\/([a-f0-9]{64})(\/artifact)?$/.exec(url.pathname);
      if (match && request.method === "GET") {
        const job = store.get(match[1]!);
        if (!job) throw new HttpError(404, "review job not found");
        if (match[2]) {
          if (job.state !== "completed") throw new HttpError(409, "review artifact is not available");
          respond(response, 200, store.artifact(job.id));
        } else respond(response, 200, job);
        return;
      }
      throw new HttpError(404, "route not found");
    })().catch((error: unknown) => {
      request.resume();
      response.setHeader("connection", "close");
      respond(response, error instanceof HttpError ? error.status : error instanceof StoreFullError ? 503 : 500, { error: error instanceof HttpError || error instanceof StoreFullError ? error.message : "internal service error" });
    });
  });
  server.maxConnections = 128;
  server.maxRequestsPerSocket = 100;
  return {
    store,
    async listen(port = 0, host = "127.0.0.1"): Promise<AddressInfo> {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.removeListener("error", reject); resolve(); }); });
      pump();
      return server.address() as AddressInfo;
    },
    async close(): Promise<void> {
      stopped = true;
      for (const worker of active.values()) worker.controller.abort(new Error("service stopping"));
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) { resolve(); return; }
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
      await Promise.allSettled([...active.values()].map((worker) => worker.finished));
      store.close();
    },
  };
}
