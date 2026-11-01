#!/usr/bin/env node
/**
 * Live evaluation run (LES-27): the same corpus as tests/eval.test.ts
 * but with real Spark (muse-spark-1.3) and Wonder (muse-wonder-1.0)
 * clients, tool_choice auto, via review(). Appends a dated section
 * to docs/eval-live-runs.md with the model identifiers so a model
 * change shows up as a diff in the numbers.
 *
 * Usage: MODEL_API_KEY=... npx tsx eval/run-live.ts
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGuestClient, SPARK_MODEL } from "../src/classify/client.js";
import { WONDER_MODEL } from "../src/plan/plan.js";
import { EVAL_CASES } from "./cases.js";
import { runCase } from "./run.js";
import { renderScoreTable, scoreCorpus } from "./score.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const spark = createGuestClient();
const wonder = createGuestClient({ env: { ...process.env, META_MODEL: WONDER_MODEL } });

const scores = [];
for (const c of EVAL_CASES) {
  const { score } = await runCase(repoRoot, c, { spark, wonder });
  scores.push(score);
  console.log(`${c.id}: verdict ${score.actualVerdict} (expected ${score.expectedVerdict}), kept ${score.kept}, dropped ${score.dropped}`);
}
const corpus = scoreCorpus(scores);
const date = new Date().toISOString().slice(0, 10);
const section = [
  "",
  `## ${date} — spark ${SPARK_MODEL}, wonder ${WONDER_MODEL}`,
  "",
  `Run at ${new Date().toISOString()} with product calls to https://api.meta.ai/v1 (tool_choice auto).`,
  "",
  renderScoreTable(corpus),
  "",
].join("\n");

const docPath = join(repoRoot, "docs/eval-live-runs.md");
if (!existsSync(docPath)) {
  appendFileSync(docPath, "# Live evaluation runs (LES-27)\n\nRecorded live runs of the eval corpus (`eval/`). Each section is one run: model identifiers, date, and the precision/recall/verdict table. A model change shows up as a diff in these numbers.\n");
}
void readFileSync(docPath, "utf8");
appendFileSync(docPath, section);
console.log(`\nappended to docs/eval-live-runs.md\n\n${renderScoreTable(corpus)}`);
