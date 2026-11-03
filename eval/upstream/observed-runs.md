# Upstream pilot observations — 2026-11-03 UTC

These are measured outcomes, not a claim of general model quality. Raw evidence
is retained locally under `.lesscode-eval/` and is intentionally not committed.

## is-number-refactor: live invocation checks pass; note quality needs improvement

- Evaluator/product commit: `3b55d937d4c6ce0666e2db6fb44dcc9366975c58`.
- Run: `2026-11-03T05-45-29-536Z-ae55ad68-eada-4d87-959e-9528f25ce994`.
- Upstream base/head: the exact commits in `manifest.json`; base syntax + 139 upstream tests passed, head syntax + 112 upstream tests passed.
- Provider: Baseten, `meta-models/muse-spark-open-1026` observed for both roles in all three invocations.
- Selection: only `is-number-refactor`; `is-plain-obj-performance` was explicitly excluded and is not certified by this run.

| Adapter | Verdict | Outcome | Spark/Wonder calls | Total tokens | Run ID |
| --- | --- | --- | --- | ---: | --- |
| engine | reviewed | no-change | 1/1 | 15771 | `a64c8917-9c6f-46c6-8529-16c23cf81471` |
| mcp | reviewed | review-only | 1/1 | 15996 | `57a421c7-1bc4-4427-8b6c-e5891cbd4501` |
| cli | reviewed | review-only | 1/1 | 16449 | `8ac97377-660d-473f-8e75-8a3a1d8599b4` |

Total observed usage: **48,216 tokens across six requests**. No patch was applied.
Independent receipts, canonical records, source revisions, Docker identity, exit
codes, response counts and usage totals validate. These records also pass the
subsequent strengthened usage/response-count validator.

Manual review found substantive errors in the notes:

1. MCP and CLI say the benchmark functions throw `ReferenceError` because they
   reference undeclared `num`. The variable-name defect is real and pre-existing,
   but `typeof num` is safe: the functions fall through and return `false`.
   Executing the exact pinned declarations in the isolated runner confirmed
   `[false, false]` for numeric inputs without throwing.
2. MCP suggests the historic `0e+5` pass-case is not locked by tests, but it
   remains in `test.js:84`; the `0xff` case also remains at line 37.

These errors are recorded in the local `human-review.json`, with record and
probe-source hashes. The mechanical result is valid; the review content has
**not passed a quality sign-off**. The engine invocation had no notes. Different
notes across independent live calls are expected; matching verdicts do not
establish note correctness or identical model behavior.

## is-plain-obj-performance: baseline blocked; no model evaluation

- Attempt commit: `1a6f75a`.
- Run: `2026-11-03T05-41-38-944Z-70c82f5e-9569-44c5-b269-9ae02d632f1d`.
- Base syntax check and AVA behavior test passed; tsd then failed on dependency
  type declarations under the Node 22 runner. No adapter was invoked.
- The failed historical attempt is retained. Its initial source-patch writer
  trimmed trailing whitespace; the implementation was corrected to preserve
  exact raw Git diff bytes before the successful is-number run. Do not reuse
  that first attempt as exact-patch provenance.

## Next evidence needed

Expand beyond these two cases with independently reviewed patches, reproducible
dependency recipes, and expectations about findings and notes. Address the
observed factual errors in senior-review output and rerun an independent holdout
before claiming an improvement. Keep transport/gate correctness separate from
model-quality judgments.
