#!/usr/bin/env node
// Thin adapter over the pull-request caller (src/pr/pr.ts), which
// resolves checkout/base/intent from the PR's declared
// lesscode-pr.json and calls review().
//
// Usage: pr-review --repo <dir> [--result <file>]
// Prints both posts on stdout as JSON: { check, comment }. The check
// body is exactly the gate result; the comment body is exactly the
// senior-note markdown. Exit 0 when the check succeeds (gate
// accepted), 1 when it fails (a failing gate can be a required
// check), 2 when the run itself fails (e.g. a missing/bad
// declaration). The run never modifies the PR branch, never applies
// the patch, and never merges.
import { writeFileSync } from "node:fs";
import { runPrReview } from "./pr.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const repo = arg("repo");
if (!repo) {
  console.error("missing --repo (the PR checkout, carrying lesscode-pr.json)");
  process.exit(2);
}
try {
  const { result, check, comment } = await runPrReview({ checkout: repo });
  console.log(JSON.stringify({ check, comment }, null, 2));
  // The full result (verdict, patch the caller may apply, findings,
  // gate, note) is for the caller; stdout stays the two posts alone.
  const out = arg("result");
  if (out) writeFileSync(out, JSON.stringify(result, null, 2));
  process.exit(result.verdict === "failed" ? 2 : check.conclusion === "success" ? 0 : 1);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
