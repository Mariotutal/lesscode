#!/usr/bin/env node
// Thin adapter. Run `npm run simplify -- --help` for usage.
// Exit 0 accepted, 1 refused or reviewed, 2 run failure.
import { simplify } from "./simplify.js";
import { tryParse, handleHelpOrError, exitCodeForVerdict } from "../cli/args.js";
const usage = "Usage: simplify --repo <dir> --base <ref> --intent <f,f> [--tests <p,p>] [--help]\nExit 0 accepted, 1 refused or reviewed, 2 run failure.";
const args = tryParse(process.argv.slice(2), [{name:"repo",kind:"value",required:true},{name:"base",kind:"value",required:true},{name:"intent",kind:"list",required:true},{name:"tests",kind:"list"}], usage);
if (handleHelpOrError(args, usage)) process.exit(0);
try {
  const result = await simplify({ checkout: args.values.get("repo")!, base: args.values.get("base")!, intent: args.lists.get("intent")!, relatedTests: args.lists.get("tests") ?? [] });
  console.log(JSON.stringify(result, null, 2));
  if ("summary" in result && result.summary) console.error(result.summary);
  process.exit(exitCodeForVerdict(result.verdict));
} catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
