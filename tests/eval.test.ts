import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "../eval/cases.js";
import { MUTATIONS, runMutation } from "../eval/mutate.js";
import { materializeCase, runCase, scriptedClient } from "../eval/run.js";
import { renderScoreTable, scoreCase, scoreCorpus } from "../eval/score.js";

const exec = promisify(execFile);
const root = process.cwd();

describe("eval scoring (pure)", () => {
  it("counts reported/kept/dropped and precision/recall against known answers", () => {
    const s = scoreCase({
      id: "x",
      expected: [{ category: "single-use-abstraction", file: "a.ts" }, { category: "duplicate-helper", file: "b.ts" }],
      sparkReported: [
        { category: "single-use-abstraction", file: "a.ts" },
        { category: "duplicate-helper", file: "b.ts" },
        { category: "single-use-abstraction", file: "load.ts" },
      ],
      kept: [{ category: "single-use-abstraction", file: "a.ts" }],
      expectedVerdict: "accepted",
      actualVerdict: "reviewed",
      modelCalls: 2,
      tokens: 30,
      ms: 1000,
    });
    expect(s).toMatchObject({ reported: 3, kept: 1, dropped: 2, truePositives: 1, falsePositives: 0, falseNegatives: 1, verdictMatch: false });
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(0.5);
    const table = renderScoreTable(scoreCorpus([s]));
    expect(table).toContain("| x | 3 | 1 | 2 | 100.0% | 50.0% | accepted | reviewed | NO | 2 | 30 | 1.0s |");
  });

  it("a kept finding with no matching answer is a false positive", () => {
    const s = scoreCase({
      id: "y", expected: [], kept: [{ category: "single-use-abstraction", file: "load.ts" }],
      expectedVerdict: "reviewed", actualVerdict: "reviewed", modelCalls: 2, tokens: 0, ms: 0,
    });
    expect(s.precision).toBe(0);
    expect(s.recall).toBe(1);
  });
});

describe("eval corpus (scripted model)", () => {
  it("no eval case touches a sealed tree", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const c of EVAL_CASES) {
      expect(c.dir, c.id).not.toContain("sealed");
      for (const f of walk(join(root, c.dir))) {
        expect(f, `${c.id}: ${f}`).not.toContain("/sealed/");
        expect(readFileSync(f, "utf8"), `${c.id}: ${f}`).not.toContain("sealed");
      }
    }
  });

  it("runs every case, prints the precision/recall/verdict table, verdicts match known answers", async () => {
    const scores = [];
    for (const c of EVAL_CASES) {
      const scripted = scriptedClient(c);
      const { score, result } = await runCase(root, c, { spark: scripted.client, wonder: scripted.client });
      scores.push(score);
      expect(scripted.wonderCalls(), `${c.id}: Wonder must be called exactly once`).toBe(1);
      expect(score.verdictMatch, `${c.id}: expected ${c.expectedVerdict}, got ${score.actualVerdict} (${result.detail.reasons.join("; ")})`).toBe(true);
      if (c.id === "load-bearing-wrapper" || c.id === "duplicate-not-equivalent") {
        // The scripted Spark false positive must be dropped by code, not kept.
        expect(score.kept, c.id).toBe(0);
        expect(score.dropped, c.id).toBe(1);
        expect(result.applied, c.id).toBe("");
      }
      if (c.id === "pre-failing-tests") {
        expect(result.gate?.checks.find((x) => x.name === "baseline-pre-existing-failures")?.detail, c.id).toMatch(/already fails/);
      }
      if (c.id === "convention-unregistered") {
        expect(result.review.items.some((i) => i.kind === "practice" && i.text.includes("no-console-log")), c.id).toBe(true);
      }
      if (c.id === "js-no-tsconfig") {
        expect(result.detail.tsConfig, c.id).toEqual({ allowJs: false, checkJs: false });
        expect(result.applied, c.id).toContain("getJson(`/users/${id}`)");
      }
      if (c.id === "prompt-injection") {
        expect(result.applied, c.id).not.toBe("");
        expect(result.applied, c.id).not.toMatch(/tests\//);
      }
    }
    const corpus = scoreCorpus(scores);
    const table = renderScoreTable(corpus);
    console.log(`\nLES-27 eval corpus (scripted model)\n${table}\n`);
    expect(corpus.verdictMatches).toBe(EVAL_CASES.length);
    expect(corpus.precision).toBe(1);
    expect(corpus.recall).toBe(1);
  }, 600_000);

  it("gate mutations: accepted patch mutated in an uncovered behaviour — state plainly which check catches it", async () => {
    const c = EVAL_CASES.find((x) => x.id === "inline-basic")!;
    const dir = await materializeCase(root, c);
    const parent = mkdtempSync(join(tmpdir(), "lc-eval-mut-"));
    try {
      // Rebuild the accepted patch tree: apply review()'s patch in a scratch commit.
      const scripted = scriptedClient(c);
      const { result } = await runCase(root, c, { spark: scripted.client, wonder: scripted.client });
      // runCase cleaned its own checkout; redo on `dir` via git apply of the accepted patch.
      expect(result.verdict).toBe("accepted");
      const patchPath = join(parent, "accepted.patch");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(patchPath, result.applied);
      await exec("git", ["apply", patchPath], { cwd: dir });
      await exec("git", ["add", "-A"], { cwd: dir });
      await exec("git", ["-c", "user.email=eval@local", "-c", "user.name=eval", "commit", "-qm", "accepted patch"], { cwd: dir });

      const outcomes = [];
      for (const m of MUTATIONS) {
        outcomes.push(await runMutation({
          acceptedDir: dir,
          // Diff the mutation against the ACCEPTED commit, not the
          // PR base: the accepted patch itself must not trip
          // size/coverage checks meant for candidate edits.
          baseRef: "HEAD",
          editSet: ["src/userApi.ts", "src/userFetcher.ts"],
          relatedTests: ["tests"],
          mutation: m,
          scratchParent: parent,
        }));
      }
      const lines = outcomes.map((o) => `${o.id}: ${o.statement}`);
      console.log(`\nLES-27 gate mutations\n${lines.join("\n")}\n`);
      for (const o of outcomes) {
        const m = MUTATIONS.find((x) => x.id === o.id)!;
        if (m.expectedCheck) expect(o.caughtBy, `${o.id} should be caught by ${m.expectedCheck} (failed: ${o.failedChecks.join(", ")})`).toBe(m.expectedCheck);
        else {
          // No tree-scoped check catches it. The full gate may still
          // reject on patch-scoped checks (size vs the PR head) —
          // that is the patch being judged, not the mutation; the
          // statement must say which, plainly.
          expect(o.caughtBy, `${o.id}: expected NO tree check to catch it, got ${o.failedChecks.join(", ")}`).toBeNull();
          expect(o.statement).toContain("NO CHECK CAUGHT THIS MUTATION");
          expect(o.statement).toMatch(/patch-scoped checks that fired: /);
          expect(o.treeChecksPassed, o.id).toBe(true);
        }
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(join(dir, ".."), { recursive: true, force: true });
      expect(existsSync(dir)).toBe(false);
    }
  }, 600_000);
});
