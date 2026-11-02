#!/usr/bin/env node
// GitHub caller: posts the gate as a Check Run and the note as one
// comment, and offers the accepted patch without applying it to the PR.
// Usage: github-pr-review --owner <o> --repo-name <r> --pr <n> [--checkout <dir>] [--offer branch|suggestions|none] [--suggestion-branch <name>] [--help]
// Env: GITHUB_TOKEN (or GH_TOKEN), GITHUB_API_URL optional. Token never printed.
// Exit 0 accepted, 1 refused or reviewed, 2 run failure.
// Ownership: the CLI owns the Docker executor it creates for fetched mode and
// disposes it before termination. A programmatic caller's injected executor
// remains caller-owned. Local --checkout mode uses trusted-local execution.
import { createDockerExecutor } from "../execution/index.js";
import { createGithubApi, runGithubPrReview, type PatchOffer } from "./github.js";
import { tryParse, handleHelpOrError, exitCodeForVerdict } from "../cli/args.js";
const usage = "Usage: github-pr-review --owner <o> --repo-name <r> --pr <n> [--checkout <dir>] [--offer branch|suggestions|none] [--suggestion-branch <name>] [--help]\nExit 0 accepted, 1 refused or reviewed, 2 run failure. Never applies the patch to the PR branch, never merges.";
const args = tryParse(process.argv.slice(2), [{name:"owner",kind:"value",required:true},{name:"repo-name",kind:"value",required:true},{name:"pr",kind:"value",required:true},{name:"checkout",kind:"value"},{name:"offer",kind:"value"},{name:"suggestion-branch",kind:"value"}], usage);
if (handleHelpOrError(args, usage)) process.exit(0);
const offer = (args.values.get("offer") ?? "none") as PatchOffer;
if (!["branch","suggestions","none"].includes(offer)) { console.error(`invalid --offer ${offer}\n${usage}`); process.exit(2); }
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
if (!token) { console.error("missing GITHUB_TOKEN (or GH_TOKEN)"); process.exit(2); }
let ownedExecutor: ReturnType<typeof createDockerExecutor> | undefined;
let disposeOnce: Promise<void> | undefined;
const getDispose = () => disposeOnce ??= (async () => {
  if (!ownedExecutor) return;
  try { await ownedExecutor.dispose(); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); }
})();
const abortController = new AbortController();
const onSignal = () => abortController.abort();
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
try {
  const api = createGithubApi({ token, ...(process.env.LESSCODE_GITHUB_APP_ID ? { publisherAppId: Number(process.env.LESSCODE_GITHUB_APP_ID) } : {}), ...(process.env.GITHUB_API_URL ? { baseUrl: process.env.GITHUB_API_URL } : {}) });
  const useCheckout = args.values.has("checkout");
  if (!useCheckout) ownedExecutor = createDockerExecutor({ image: process.env.LESSCODE_RUNNER_IMAGE ?? "lesscode-runner:local" });
  const out = await runGithubPrReview({ api, owner: args.values.get("owner")!, repo: args.values.get("repo-name")!, prNumber: Number(args.values.get("pr")), ...(useCheckout ? { checkout: args.values.get("checkout")! } : { executor: ownedExecutor! }), offer, ...(args.values.has("suggestion-branch") ? { suggestionBranch: args.values.get("suggestion-branch")! } : {}), signal: abortController.signal });
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = exitCodeForVerdict(out.verdict);
} catch (e) {
  if (abortController.signal.aborted) console.error("review cancelled");
  else console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 2;
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  await getDispose();
}
