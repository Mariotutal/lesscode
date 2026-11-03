# Validation status and limits

This page separates implementation checks, model evidence and deployment readiness. Historical reports are not rewritten as if they describe the current code.

## Recorded implementation validation

The factual-verification change merged as PR #44 recorded **267 passing tests across 24 files**, plus build, typecheck, lint and documentation build. These are dated observations for that implementation, not a permanent test-count promise.

From a source checkout:

```sh
npm test
npm run typecheck
npm run lint
npm run docs:build
npm pack --dry-run
```

`npm test` rebuilds first. The suite uses scripted/recording model transports, temporary repositories, fixture dependency installs, packaged CLI checks, and real loopback MCP/hosted integration tests. It is not a live-model accuracy study. Dependency installation can require network, and HTTP integration tests require local socket permission. Do not weaken assertions or count sandbox permission failures as product passes.

For a narrower factual regression check:

```sh
node ./node_modules/vitest/vitest.mjs run tests/review-claims.test.ts tests/engine.test.ts
```

The verifier includes adversarial claims, wrong IDs/citations, true claims attached to false prose, serialization edge cases, a real exception positive control, and comparisons with JavaScript on fixed trusted test programs. Production verification never evaluates extracted repository code.

## Evaluation map

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Maintained synthetic corpus (`eval/cases.ts`, ten cases) | Scripted mechanics, closed findings, patch gate/known-answer behavior. | General model accuracy on real projects. |
| `eval/run-live.ts` | Real configured model calls over that synthetic corpus; appends a dated measurement section. | An upstream corpus or complete factual correctness. |
| Pinned upstream pilot (`eval/upstream/`) | Immutable source/license checks, actual separate engine/MCP/CLI calls and canonical/provenance evidence. | A completed 30-project study, automatic skill discovery, or HTTP live-model transport evaluation. |
| Paired accuracy controls (`eval/upstream/accuracy.ts`) | Independently checked small-case runtime/assertion facts plus actual model responses. | Broad unseen precision/recall, full coverage, or all-input equivalence. |
| Factual verification layer | Code checks supported declared claims and renders bounded verified facts; unsupported/contradicted declared items are withheld. | General natural-language claim extraction or correctness of unstructured advice. |
| Old `live-corpus-30` submission | Retained diagnostic history of a defective evaluator. | Valid live-model, upstream or adapter-quality evidence. |

## Run the maintained synthetic live corpus

Supply operator model configuration and credentials first:

```sh
node --import tsx eval/run-live.ts
```

This command makes real model calls and appends to `docs/eval-live-runs.md`. It has no dry-run mode selected by `EVAL_LIVE=0` and no corpus-wide hard spending cap. Its model client has the normal attempt timeout/retry policy. Use the scripted tests when you want no provider requests.

## Run the pinned pilot

Use an approved preinstalled runner image and commit tracked evaluator changes before recording provenance:

```sh
LESSCODE_RUNNER_IMAGE=lesscode-runner:local npm run eval:upstream -- --baseline
LESSCODE_RUNNER_IMAGE=lesscode-runner:local npm run eval:upstream -- --baseline --case is-number-refactor
```

Baseline mode makes no model calls. The full manifest includes a historical is-plain-obj case whose old TypeScript dependency tooling was incompatible with the tested Node 22 environment; that recorded failure was preserved. Selecting another case explicitly records excluded IDs rather than certifying them.

For real calls, the pilot requires explicit `LESSCODE_API_KEY`, `LESSCODE_API_BASE_URL`, `LESSCODE_SPARK_MODEL` and `LESSCODE_WONDER_MODEL`:

```sh
LESSCODE_RUNNER_IMAGE=lesscode-runner:local npm run eval:upstream -- --live --case is-number-refactor
LESSCODE_RUNNER_IMAGE=lesscode-runner:local node --import tsx eval/upstream/accuracy.ts --live
```

Neither evaluator automatically loads `.env`. The pilot caps each adapter at four HTTP attempts, 32,768 request bytes and 8,192 completion tokens per attempt. This is not a dollar cap. Failed prerequisites, missing records, invalid envelopes, mismatches and timeouts fail the mechanical run. Private evidence goes to unique `.lesscode-eval/` directories and is excluded from Git. Passing canonical/provenance checks does not sign off on note quality.

## Observed factual outcomes

The November 3 factual-verification pilot used 14 real Baseten requests across four paired controls and one selected upstream change. In the guarded-name control, code-rendered text established `returns:false` under explicit assumptions. The genuinely unguarded positive control retained its checked `ReferenceError`. MCP and CLI returned the correct bounded benchmark facts in the larger upstream repeat; engine returned no notes. Unsupported/miscited declared claims were withheld. No patch was applied.

Detailed committed source guides and observations:

- [Pinned pilot guide](https://github.com/Mariotutal/lesscode/blob/master/eval/upstream/README.md)
- [First upstream pilot observations](https://github.com/Mariotutal/lesscode/blob/master/eval/upstream/observed-runs.md)
- [Accuracy investigation and failed guidance experiment](https://github.com/Mariotutal/lesscode/blob/master/eval/upstream/review-accuracy.md)
- [Factual verification results](https://github.com/Mariotutal/lesscode/blob/master/eval/upstream/factual-verification-results.md)
- [Quarantined external corpus](https://github.com/Mariotutal/lesscode/blob/master/eval/live-corpus-30/README.md)

Raw private evidence is retained locally under `.lesscode-eval/`. The earlier prompt-guidance candidate did not fix the larger input and was removed; the implemented check is code-owned verification, not an agreeing second model.

## Remaining limits

- The mutation suite still documents an uncovered error-path mutation that tests, types and lint do not catch. Gate acceptance is not semantic-equivalence proof.
- Verified primitive facts apply to listed inputs and assumptions, not arbitrary globals, imports or whole-program execution.
- Assertion-source presence is not execution or complete coverage. Missing catalog evidence never proves no test exists.
- Unstructured advice remains explicitly unverified and may contain factual premises. An empty note is not evidence of recall.
- Automatic skill discovery/selection in every external AI host is unmeasured; the underlying CLI and official MCP paths have been exercised.
- The hosted file store is single-process/single-tenant. Distributed cancellation, transactional tenant scheduling, retention, authorization and hostile multi-tenant isolation remain work.

See [factual verification](factual-review-verification.md), [hosted deployment](hosted-deployment.md), and [historical measurements](eval-live-runs.md). Do not derive a global review-accuracy percentage from these small, targeted runs.
