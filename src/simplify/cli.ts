#!/usr/bin/env node
// Thin adapter over simplify(checkout, base, intent).
// Usage: simplify --repo <dir> --base <ref> --intent <f,f> [--tests <p,p>]
// Prints the result as JSON. Exit 0 accepted, 1 refused, 2 run failure.
import { simplify } from "./simplify.js";

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
try {
  const result = await simplify({ checkout: repo, base, intent, relatedTests: list("tests") });
  console.log(JSON.stringify(result, null, 2));
  console.log(result.summary);
  process.exit(result.verdict === "accepted" ? 0 : 1);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
