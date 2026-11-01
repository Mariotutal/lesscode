#!/usr/bin/env node
// Deterministic gate CLI. No model calls.
// Usage: gate --repo <dir> --base <ref> --edit <f,f> --tests <p,p> [--help]
// Exit 0 accepted, 1 refused or reviewed, 2 run failure.
import { evaluateGate } from "./gate.js";
import { tryParse, handleHelpOrError, exitCodeForVerdict } from "../cli/args.js";
const usage = "Usage: gate --repo <dir> --base <ref> --edit <f,f> --tests <p,p> [--help]\nExit 0 accepted, 1 refused or reviewed, 2 run failure.";
const args = tryParse(process.argv.slice(2), [{name:"repo",kind:"value",required:true},{name:"base",kind:"value",required:true},{name:"edit",kind:"list",required:true},{name:"tests",kind:"list",required:true}], usage);
if (handleHelpOrError(args, usage)) process.exit(0);
try {
  const result = await evaluateGate({ repoDir: args.values.get("repo")!, baseRef: args.values.get("base")!, editSet: args.lists.get("edit")!, relatedTests: args.lists.get("tests")! });
  console.log(JSON.stringify(result, null, 2));
  process.exit(exitCodeForVerdict(result.accepted ? "accepted" : "refused"));
} catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
