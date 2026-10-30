#!/usr/bin/env node
// LES-4 pipeline CLI: Spark classifies, Wonder plans once, code applies
// surgically, the deterministic gate decides.
// Usage: plan --repo <dir> --base <ref> --gate-base <ref> --intent <f,f> --tests <p,p>
// Exit 0 = gate accepted, 1 = refused/rejected, 2 = model/config failure.
import { runPipeline } from "./pipeline.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const list = (name: string) => (arg(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const repo = arg("repo");
if (!repo || !arg("base") || !arg("gate-base")) {
  console.error("missing --repo/--base/--gate-base");
  process.exit(2);
}
try {
  const result = await runPipeline({
    checkoutDir: repo,
    baseRef: arg("base")!,
    gateBaseRef: arg("gate-base")!,
    intentFiles: list("intent"),
    relatedTests: list("tests").length ? list("tests") : ["tests"],
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.gate?.accepted ? 0 : 1);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
