#!/usr/bin/env node
/**
 * Live evaluation run (LES-27, LES-54): the same corpus as
 * tests/eval.test.ts but with real model clients, tool_choice auto,
 * via review(). Appends a dated section to docs/eval-live-runs.md
 * with the model identifiers so a model change shows up as a diff
 * in the numbers.
 *
 * Usage: LESSCODE_API_KEY=... npx tsx eval/run-live.ts
 * Roles resolve through the provider factory: LESSCODE_SPARK_MODEL /
 * LESSCODE_WONDER_MODEL (shared LESSCODE_MODEL), LESSCODE_API_BASE_URL,
 * or a committed `.lesscode.json`. Examples:
 *   LESSCODE_SPARK_MODEL=meta/muse-spark-1.3 LESSCODE_WONDER_MODEL=anthropic/claude-sonnet-4
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGuestClient } from "../src/classify/client.js";
import { EVAL_CASES } from "./cases.js";
import { runCase } from "./run.js";
import { renderScoreTable, scoreCorpus } from "./score.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const spark = createGuestClient({ role: "spark" });
const wonder = createGuestClient({ role: "wonder" });
const sparkModel = spark.config.model;
const wonderModel = wonder.config.model;

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
  `## ${date} — spark ${sparkModel}, wonder ${wonderModel}`,
  "",
  `Run at ${new Date().toISOString()} with product calls to ${spark.config.baseUrl} / ${wonder.config.baseUrl} (tool_choice auto).`,
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
