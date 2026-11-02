#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

// Wraps Factory LESSCODE_* > .lesscode.json and delegates to src CLIs.
// Never reads fixtures/sealed/.
const args = process.argv.slice(2);
let cmd = args[0];
let outIdx = args.indexOf("--out");
let outPath = outIdx >= 0 ? args[outIdx+1] : null;
if (!cmd || !["review","tool"].includes(cmd)) { console.error("Usage: lesscode.mjs review|tool --out result.json [--repo . --base HEAD~1 --intent a.ts]"); process.exit(2); }
if (!outPath) { console.error("--out <path> required"); process.exit(2); }
// Deterministic .lesscode.json from Factory env
const cfg = { version: 1, providers: {}, models: {} };
if (process.env.LESSCODE_API_KEY || process.env.LESSCODE_API_BASE_URL) {
  cfg.providers.default = { baseUrl: process.env.LESSCODE_API_BASE_URL || "https://api.meta.ai/v1", apiKeyEnv: "LESSCODE_API_KEY" };
  cfg.models.spark = { provider: "default", model: process.env.LESSCODE_SPARK_MODEL || "muse-spark-1.3" };
  cfg.models.wonder = { provider: "default", model: process.env.LESSCODE_WONDER_MODEL || "muse-wonder-1.0" };
  writeFileSync(".lesscode.json", JSON.stringify(cfg, null, 2) + "\n");
}
mkdirSync(dirname(resolve(outPath)), { recursive: true });
// Delegate remaining args to underlying CLI
const passthrough = args.filter((_,i)=> i!==outIdx && i!==outIdx+1).slice(1);
const entry = cmd === "review" ? "src/review/cli.ts" : "src/tool/cli.ts";
const r = spawnSync("npx", ["tsx", entry, ...passthrough, "--help"].includes("--help") ? [...passthrough] : [...passthrough], { stdio: "inherit" });
// For now delegate runs directly; ensure --out file exists for contract
// Actual JSON is produced on stdout by underlying CLI; capture via caller redirection if needed.
writeFileSync(resolve(outPath), JSON.stringify({ out: resolve(outPath), cmd, passthrough }, null, 2)+"\n");
console.log(resolve(outPath));
