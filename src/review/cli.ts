#!/usr/bin/env node
import { runReview, renderRecordSummary } from "../engine/run.js";
import { createDockerExecutor } from "../execution/index.js";
import { tryParse, handleHelpOrError, exitCodeForVerdict } from "../cli/args.js";
const usage = "Usage: review --repo <dir> --base <ref> --intent <f,f> [--tests <p,p>] [--execution local|docker] [--runner-image <image>] [--help]\nJSON run record on stdout, human summary on stderr. Local mode executes source you trust; Docker mode requires a prebuilt runner image. Exit 0 accepted, 1 reviewed, 2 failed.";
const args = tryParse(process.argv.slice(2), [{ name: "repo", kind: "value", required: true }, { name: "base", kind: "value", required: true }, { name: "intent", kind: "list", required: true }, { name: "tests", kind: "list" }, { name: "execution", kind: "value" }, { name: "runner-image", kind: "value" }], usage);
if (handleHelpOrError(args, usage)) process.exit(0);
const execution = args.values.get("execution") ?? "local";
if (!["local", "docker"].includes(execution)) { console.error("--execution must be local or docker"); process.exit(2); }
const executor = execution === "docker" ? createDockerExecutor({ image: args.values.get("runner-image") ?? process.env.LESSCODE_RUNNER_IMAGE ?? "lesscode-runner:local" }) : undefined;
try {
  const result = await runReview({ checkout: args.values.get("repo")!, base: args.values.get("base")!, intent: args.lists.get("intent")!, relatedTests: args.lists.get("tests"), executor });
  console.log(JSON.stringify(result, null, 2));
  console.error(renderRecordSummary(result));
  process.exitCode = exitCodeForVerdict(result.verdict);
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
finally { await executor?.dispose(); }
