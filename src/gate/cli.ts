#!/usr/bin/env node
// Deterministic gate CLI. No model calls. Prints the metric struct as JSON;
// UIs must read this + exit codes, not prose.
// Usage: gate --repo <dir> --base <ref> --edit <file,file> --tests <path,path>
// Exit 0 = accepted, 1 = rejected. JSON on stdout either way.
import { evaluateGate } from "./gate.js";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1]!;
}
const list = (name: string) => arg(name).split(",").map((s) => s.trim()).filter(Boolean);

const result = await evaluateGate({
  repoDir: arg("repo"),
  baseRef: arg("base"),
  editSet: list("edit"),
  relatedTests: list("tests"),
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.accepted ? 0 : 1);
