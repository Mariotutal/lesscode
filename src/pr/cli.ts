#!/usr/bin/env node
// Thin adapter over the pull-request caller (src/pr/pr.ts), which
// resolves checkout/base/intent from the PR's declared
// lesscode-pr.json and calls simplifyTool.
//
// Usage: pr-check --repo <dir>
// Prints the check on stdout (JSON: { name, conclusion, body }) and
// the full SimplifyResult on stderr. Exit 0 when the check succeeds
// (gate accepted), 1 when it fails (a failing gate can be a required
// check), 2 when the run itself fails (e.g. a missing/bad declaration).
// The run never modifies the PR branch and never merges.
import { writeFileSync } from "node:fs";
import { runPrSimplifyCheck } from "./pr.js";

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
  const { result, check } = await runPrSimplifyCheck({ checkout: repo });
  // Keep stdout to the single check JSON — the body's gate JSON is
  // embedded as a string, so the full result would nest escapes.
  console.log(JSON.stringify(check, null, 2));
  // The full result (verdict, patch the caller may apply, findings,
  // gate) is for the caller; stdout stays the check alone. Use a
  // file, not stderr, so long patches are not interleaved.
  const out = arg("result");
  if (out) writeFileSync(out, JSON.stringify(result, null, 2));
  else console.error(JSON.stringify({ verdict: result.verdict, gate: result.gate }));
  process.exit(check.conclusion === "success" ? 0 : 1);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
