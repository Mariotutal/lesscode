#!/usr/bin/env node
// Thin adapter over runPrReview (src/pr/pr.ts). Prints { check, comment }.
// Usage: pr-review --repo <dir> [--result <file>] [--help]
// Exit 0 accepted, 1 refused or reviewed, 2 run failure.
import { writeFileSync } from "node:fs";
import { runPrReview } from "./pr.js";
import { tryParse, handleHelpOrError, exitCodeForVerdict } from "../cli/args.js";
const usage = "Usage: pr-review --repo <dir> [--result <file>] [--help]\nExit 0 accepted, 1 refused or reviewed, 2 run failure. Never modifies the PR branch, never applies the patch, never merges.";
const args = tryParse(process.argv.slice(2), [{name:"repo",kind:"value",required:true},{name:"result",kind:"value"}], usage);
if (handleHelpOrError(args, usage)) process.exit(0);
try {
  const { result, check, comment } = await runPrReview({ checkout: args.values.get("repo")! });
  console.log(JSON.stringify({ check, comment }, null, 2));
  if (args.values.has("result")) writeFileSync(args.values.get("result")!, JSON.stringify(result, null, 2));
  process.exit(exitCodeForVerdict(result.verdict));
} catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
