#!/usr/bin/env node
// Spark classifier CLI (only classification model call).
// Usage: classify --repo <dir> [--base <ref> --intent <f,f>] [--files <f,f>] [--client-fixture <file>] [--help]
// Exit 0 ran, 1 refused or reviewed, 2 run failure.
import { readFileSync } from "node:fs";
import { classifyFindings } from "./classify.js";
import { changedFilesFromGit } from "./checkout.js";
import { tryParse, handleHelpOrError } from "../cli/args.js";
const usage = "Usage: classify --repo <dir> [--base <ref> --intent <f,f>] [--files <f,f>] [--client-fixture <file>] [--help]\nExit 0 ran, 1 refused or reviewed, 2 run failure.";
const args = tryParse(process.argv.slice(2), [{name:"repo",kind:"value",required:true},{name:"base",kind:"value"},{name:"intent",kind:"list"},{name:"files",kind:"list"},{name:"client-fixture",kind:"value"}], usage);
if (handleHelpOrError(args, usage)) process.exit(0);
const repo = args.values.get("repo")!;
const scopeCreep = args.values.has("base") ? { changedFiles: await changedFilesFromGit(repo, args.values.get("base")!), intentFiles: args.lists.get("intent") ?? [] } : undefined;
let client;
if (args.values.has("client-fixture")) {
  const bodies = JSON.parse(readFileSync(args.values.get("client-fixture")!, "utf8")) as unknown[];
  let i = 0;
  client = { config: { baseUrl: "fixture", apiKey: "fixture", model: "muse-spark-1.3" }, async chat() { const body = bodies[Math.min(i++, bodies.length - 1)] as { choices?: { message?: { content?: string | null; tool_calls?: never[] }; finish_reason?: string }[]; usage?: never; model?: string }; const choice = body.choices?.[0]; return { content: choice?.message?.content ?? null, toolCalls: choice?.message?.tool_calls ?? [], finishReason: choice?.finish_reason ?? null, usage: body.usage, model: body.model }; } };
}
try { const result = await classifyFindings({ checkoutDir: repo, files: args.lists.get("files")?.length ? args.lists.get("files") : undefined, scopeCreep, client }); console.log(JSON.stringify(result, null, 2)); }
catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
