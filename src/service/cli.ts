#!/usr/bin/env node
import { resolve } from "node:path";
import { createHostedRunner } from "./runner.js";
import { createReviewService } from "./server.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

try {
  const token = required("LESSCODE_SERVICE_TOKEN");
  const image = required("LESSCODE_RUNNER_IMAGE");
  const githubToken = required("GITHUB_TOKEN");
  const metaApiKey = required("META_API_KEY");
  const service = createReviewService({
    token, image,
    allowedRepositories: required("LESSCODE_ALLOWED_REPOS").split(",").map((repo) => repo.trim()).filter(Boolean),
    dataDirectory: resolve(process.env.LESSCODE_DATA_DIR ?? ".lesscode-service"),
    concurrency: process.env.LESSCODE_CONCURRENCY ? Number(process.env.LESSCODE_CONCURRENCY) : undefined,
    maxQueued: process.env.LESSCODE_MAX_QUEUE ? Number(process.env.LESSCODE_MAX_QUEUE) : undefined,
    jobTimeoutMs: process.env.LESSCODE_JOB_TIMEOUT_MS ? Number(process.env.LESSCODE_JOB_TIMEOUT_MS) : undefined,
    secrets: [githubToken, metaApiKey],
  }, { runner: createHostedRunner({ githubToken, metaApiKey, image }) });
  const port = Number(process.env.LESSCODE_PORT ?? 8787);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) { await service.close(); throw new Error("invalid LESSCODE_PORT"); }
  const address = await service.listen(port, process.env.LESSCODE_HOST ?? "127.0.0.1").catch(async (error: unknown) => { await service.close(); throw error; });
  console.log(`LessCode service listening on ${address.address}:${address.port}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void service.close().then(() => { process.exitCode = 0; }, () => { console.error("service shutdown failed"); process.exitCode = 2; });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : "service startup failed");
  process.exitCode = 2;
}
