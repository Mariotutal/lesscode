import type { ExpectedFinding } from "./types.js";

/**
 * Scoring (LES-27): pure functions, unit-tested without a model.
 *
 * A reported finding matches a known answer when category and file
 * agree (the corpus keys findings that way; citations are checked by
 * the product's own evidence filter). `kept` findings are the ones
 * that survive to the result; `dropped` are the rest of what the
 * classifier (Spark, before code verification) reported.
 *
 * Precision/recall are computed over KEPT findings against the known
 * answers: a kept finding with no matching answer is a false
 * positive, an answer with no kept match is a false negative.
 */

export interface FindingKey { category: string; file: string }

export const keyOf = (f: FindingKey): string => `${f.category}\0${f.file}`;

export interface CaseScore {
  id: string;
  /** Kept findings (post-verification) as reported. */
  reported: number;
  kept: number;
  dropped: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  expectedVerdict: string;
  actualVerdict: string;
  verdictMatch: boolean;
  modelCalls: number;
  tokens: number;
  ms: number;
}

export function scoreCase(input: {
  id: string;
  expected: readonly ExpectedFinding[];
  /** Everything Spark reported (pre-verification), when known; defaults to kept. */
  sparkReported?: readonly FindingKey[];
  kept: readonly FindingKey[];
  expectedVerdict: string;
  actualVerdict: string;
  modelCalls: number;
  tokens: number;
  ms: number;
}): CaseScore {
  const expectedKeys = new Set(input.expected.map(keyOf));
  const keptKeys = input.kept.map(keyOf);
  const tp = keptKeys.filter((k) => expectedKeys.has(k)).length;
  const fp = keptKeys.length - tp;
  // Answers matched by at least one kept finding.
  const matched = new Set(keptKeys.filter((k) => expectedKeys.has(k)));
  const fn = [...expectedKeys].filter((k) => !matched.has(k)).length;
  // Reported = Spark findings + code-decided findings kept in the
  // result (scope creep is decided by code, not Spark, so it is
  // reported by the pipeline and counted here). Dropped can never
  // be negative: kept beyond Spark's list are code-reported.
  const reported = Math.max(input.sparkReported?.length ?? 0, input.kept.length);
  return {
    id: input.id,
    reported,
    kept: input.kept.length,
    dropped: reported - input.kept.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    expectedVerdict: input.expectedVerdict,
    actualVerdict: input.actualVerdict,
    verdictMatch: input.expectedVerdict === input.actualVerdict,
    modelCalls: input.modelCalls,
    tokens: input.tokens,
    ms: input.ms,
  };
}

export interface CorpusScore {
  cases: CaseScore[];
  precision: number;
  recall: number;
  verdictMatches: number;
  modelCalls: number;
  tokens: number;
  ms: number;
}

export function scoreCorpus(cases: readonly CaseScore[]): CorpusScore {
  const tp = cases.reduce((a, c) => a + c.truePositives, 0);
  const fp = cases.reduce((a, c) => a + c.falsePositives, 0);
  const fn = cases.reduce((a, c) => a + c.falseNegatives, 0);
  return {
    cases: [...cases],
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    verdictMatches: cases.filter((c) => c.verdictMatch).length,
    modelCalls: cases.reduce((a, c) => a + c.modelCalls, 0),
    tokens: cases.reduce((a, c) => a + c.tokens, 0),
    ms: cases.reduce((a, c) => a + c.ms, 0),
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** The per-run table the task requires: reported/kept/dropped, precision, recall, verdict, calls, tokens, time. */
export function renderScoreTable(score: CorpusScore): string {
  const lines: string[] = [
    "| case | reported | kept | dropped | precision | recall | expected verdict | actual verdict | verdict match | model calls | tokens | time |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | ---: | ---: | ---: |",
  ];
  for (const c of score.cases) {
    lines.push(
      `| ${c.id} | ${c.reported} | ${c.kept} | ${c.dropped} | ${pct(c.precision)} | ${pct(c.recall)} | ${c.expectedVerdict} | ${c.actualVerdict} | ${c.verdictMatch ? "yes" : "NO"} | ${c.modelCalls} | ${c.tokens} | ${secs(c.ms)} |`,
    );
  }
  lines.push(
    `| **corpus** | ${score.cases.reduce((a, c) => a + c.reported, 0)} | ${score.cases.reduce((a, c) => a + c.kept, 0)} | ${score.cases.reduce((a, c) => a + c.dropped, 0)} | ${pct(score.precision)} | ${pct(score.recall)} | — | — | ${score.verdictMatches}/${score.cases.length} | ${score.modelCalls} | ${score.tokens} | ${secs(score.ms)} |`,
  );
  return lines.join("\n");
}
