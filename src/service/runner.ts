import { createGuestClient, SPARK_MODEL } from "../classify/client.js";
import { createDockerExecutor } from "../execution/index.js";
import { WONDER_MODEL } from "../plan/plan.js";
import { createGithubApi, runGithubPrReview, type GithubApi } from "../pr/github.js";
import type { HostedReviewRunner } from "./server.js";

export interface HostedRunnerConfig {
  githubToken: string;
  metaApiKey: string;
  image: string;
  /** Publication is an operator policy, never an untrusted HTTP request field. */
  publish?: boolean;
}

/** The control process owns remote credentials. Every repository executable uses a per-job isolated executor. */
export function createHostedRunner(config: HostedRunnerConfig): HostedReviewRunner {
  if (!config.githubToken || !config.metaApiKey || !config.image.trim()) throw new Error("hosted runner requires GitHub credentials, Meta credentials, and an explicit Docker image");
  const remote = createGithubApi({ token: config.githubToken });
  const sparkClient = createGuestClient({ env: { META_API_KEY: config.metaApiKey, META_MODEL: SPARK_MODEL } });
  const wonderClient = createGuestClient({ env: { META_API_KEY: config.metaApiKey, META_MODEL: WONDER_MODEL } });
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
