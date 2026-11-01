#!/usr/bin/env node
// LES-4 pipeline CLI: Spark classifies, Wonder plans once, gate decides.
// Usage: plan --repo <dir> --base <ref> --gate-base <ref> --intent <f,f> [--tests <p,p>] [--help]
// Exit 0 accepted, 1 refused or reviewed, 2 run failure.
import { runPipeline } from "./pipeline.js";
import { tryParse, handleHelpOrError, exitCodeForVerdict } from "../cli/args.js";
const usage = "Usage: plan --repo <dir> --base <ref> --gate-base <ref> --intent <f,f> [--tests <p,p>] [--help]\nExit 0 accepted, 1 refused or reviewed, 2 run failure.";
const args = tryParse(process.argv.slice(2), [{name:"repo",kind:"value",required:true},{name:"base",kind:"value",required:true},{name:"gate-base",kind:"value",required:true},{name:"intent",kind:"list"},{name:"tests",kind:"list"}], usage);
if (handleHelpOrError(args, usage)) process.exit(0);
try {
  const result = await runPipeline({ checkoutDir: args.values.get("repo")!, baseRef: args.values.get("base")!, gateBaseRef: args.values.get("gate-base")!, intentFiles: args.lists.get("intent") ?? [], relatedTests: args.lists.get("tests")?.length ? args.lists.get("tests")! : ["tests"] });
  console.log(JSON.stringify(result, null, 2));
  process.exit(exitCodeForVerdict(result.verdict));
} catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
