import { createDockerExecutor } from "../execution/index.js";
import { createModelClient } from "../provider/factory.js";
import { createGithubApi, runGithubPrReview, type GithubApi } from "../pr/github.js";
import type { HostedReviewRunner } from "./server.js";

export interface HostedRunnerConfig {
  githubToken: string;
  /** Canonical model API key (any OpenAI-compat provider). */
  apiKey?: string;
  /** @deprecated alias for apiKey */
  metaApiKey?: string;
  /** Optional provider env overrides (baseUrl/models). */
  providerEnv?: NodeJS.ProcessEnv;
  image: string;
  /** Publication is an operator policy, never an untrusted HTTP request field. */
  publish?: boolean;
}

/** The control process owns remote credentials. Every repository executable uses a per-job isolated executor. */
export function createHostedRunner(config: HostedRunnerConfig): HostedReviewRunner {
  const apiKey = config.apiKey ?? config.metaApiKey;
  if (!config.githubToken || !apiKey || !config.image.trim()) throw new Error("hosted runner requires GitHub credentials, model credentials, and an explicit Docker image");
  const remote = createGithubApi({ token: config.githubToken });
  const providerEnv: NodeJS.ProcessEnv = { ...process.env, ...config.providerEnv, LESSCODE_API_KEY: apiKey };
  const sparkClient = createModelClient("spark", { env: providerEnv });
  const wonderClient = createModelClient("wonder", { env: providerEnv });
  return async (request, signal) => {
    const executor = createDockerExecutor({ image: config.image });
    const abort = () => { void executor.dispose(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new Error("review cancelled before execution");
      const pullPath = `/repos/${request.owner}/${request.repo}/pulls/${request.prNumber}`;
      const api: GithubApi = {
        ...(remote.gitEnvironment ? { gitEnvironment: () => remote.gitEnvironment!() } : {}),
        async request(input) {
          if (signal.aborted) throw new Error("review cancelled");
          const result = await remote.request(input);
          if (input.method === "GET" && input.path === pullPath) {
            const body = result.body as { head?: { sha?: unknown } } | null;
            if (body?.head?.sha !== request.expectedHeadSha) throw new Error("pull request head moved; submit the new immutable head SHA");
          }
          return result;
        },
      };
      const options = {
        api, owner: request.owner, repo: request.repo, prNumber: request.prNumber,
        expectedHeadSha: request.expectedHeadSha, executor, signal, sparkClient, wonderClient,
        offer: "none" as const, publish: config.publish ?? false,
      };
      return await runGithubPrReview(options);
    } finally {
      signal.removeEventListener("abort", abort);
      await executor.dispose();
    }
  };
}
