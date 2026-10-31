#!/usr/bin/env node
// Thin adapter over review(checkout, base, intent).
// Usage: review --repo <dir> --base <ref> --intent <f,f> [--tests <p,p>]
// Prints the result as JSON. Exit 0 accepted/reviewed, 2 failed run.
import { review } from "./review.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const list = (name: string) => (arg(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const repo = arg("repo");
const base = arg("base");
const intent = list("intent");
if (!repo || !base || intent.length === 0) {
  console.error("missing --repo/--base/--intent (intent is required)");
  process.exit(2);
}
const result = await review({ checkout: repo, base, intent, relatedTests: list("tests").length ? list("tests") : undefined });
console.log(JSON.stringify(result, null, 2));
if (result.summary) console.log(result.summary);
process.exit(result.verdict === "failed" ? 2 : 0);
