#!/usr/bin/env node
// Spark classifier CLI. The only model call in the pipeline for
// classification (muse-spark-1.3 via the Meta guest wrapper).
// Usage:
//   classify --repo <dir> [--base <ref> --intent <file,file>]
//            [--files <file,file>] [--client-fixture <file>]
// Prints JSON: kept findings (cited only), dropped findings, refused
// convention breaks, and run metadata. Exit 0 = ran (findings may be
// empty); exit 2 = model/config failure. Scope creep is added by code
// when --base/--intent are given; the model never decides it.
import { readFileSync } from "node:fs";
import { classifyFindings } from "./classify.js";
import { changedFilesFromGit } from "./checkout.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const list = (name: string) =>
  (arg(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const repo = arg("repo");
if (!repo) {
  console.error("missing --repo");
  process.exit(2);
}

const scopeCreep =
  arg("base") !== undefined
    ? {
        changedFiles: await changedFilesFromGit(repo, arg("base")!),
        intentFiles: list("intent"),
      }
    : undefined;

// --client-fixture <file>: replay canned chat completions (file = JSON
// array of completion bodies) instead of calling the API. Test/dev only.
let client;
if (arg("client-fixture")) {
  const bodies = JSON.parse(readFileSync(arg("client-fixture")!, "utf8")) as unknown[];
  let i = 0;
  client = {
    config: { baseUrl: "fixture", apiKey: "fixture", model: "muse-spark-1.3" },
    async chat() {
      const body = bodies[Math.min(i++, bodies.length - 1)] as {
        choices?: { message?: { content?: string | null; tool_calls?: never[] }; finish_reason?: string }[];
        usage?: never;
        model?: string;
      };
      const choice = body.choices?.[0];
      return {
        content: choice?.message?.content ?? null,
        toolCalls: choice?.message?.tool_calls ?? [],
        finishReason: choice?.finish_reason ?? null,
        usage: body.usage,
        model: body.model,
      };
    },
  };
}

try {
  const result = await classifyFindings({
    checkoutDir: repo,
    files: list("files").length ? list("files") : undefined,
    scopeCreep,
    client,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
