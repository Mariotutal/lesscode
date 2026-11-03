# External audit evidence review

This is the historical correction of a withdrawn audit. Current implementation/evaluation status is in [Validation](validation.md); the later [bounded factual verifier](factual-review-verification.md) does not make the withdrawn results valid. Counts and statements about this correction below describe its original revision.

## Disposition: original audit claims withdrawn

The audit branch `external-audit/20261102-independent` at `7951e18`
adds four files to `c1b5ddb`: this report and the 30-case harness,
manifest, and results. It adds **no independent regression tests**.
The original report claimed `tests/external-*.test.ts` had been run
against both pre-hardening and post-hardening commits. Those files
are absent from this branch. Those execution claims are unsupported
and must not be used as release evidence.

The earlier text remains in Git history for review. Existing product
tests such as `tests/provider.test.ts`, `tests/engine.test.ts`,
`tests/packaged-cli.test.ts`, `tests/mcp.test.ts`, and
`tests/service.test.ts` are real, but their existence does not
substantiate the withdrawn independent-audit claims.

## Verified defects in the submitted evaluation

Inspection of the original `eval/live-corpus-30/harness.ts` found:

- `EVAL_LIVE=1` normally still injects scripted GuestClient responses.
  Only a separate `EVAL_LIVE_REAL` flag selects real guest calls.
  Expected verdicts influence the scripted responses.
- Live-mode MCP results copy guest verdicts rather than invoking MCP.
  The default live CLI path writes a fabricated partial record; changing
  the in-memory verdict afterward does not update that file.
- Dry-mode guest matching ends in `|| true`. MCP matching accepts any
  string verdict. CLI validation checks three fields instead of the
  canonical RunRecord schema. These cannot measure adapter parity.
- All cases generate generic local repositories. Upstream URLs are
  inspiration, not fetched checkouts, and SHAs are placeholders.
  License and source-history claims have not been verified.
- Fixtures include broken imports: `sharedClient.ts` is created while
  tests import `sharedApiClient.ts`; other fixtures use `.js` imports
  without generating the JavaScript or configuring a TypeScript runner.
  Scope-creep head replaces an export still imported by its tests.
  Baseline and head behavior are not independently established.
- `sealNeverRead` is hardcoded true. The summary provides no trace that
  establishes that claim. Model counts and invocation provenance are
  insufficient to establish which historical calls were real.
- The harness automatically loads `.env` and inherits its credentials
  into child processes, including a nominal dry-run CLI request.

This is evidence of a defective evaluator, **not evidence that the
product's gate or model passed or failed the stated upstream cases**.
A `reviewed` verdict alone is not a defect: a cited note without an
applied patch is a successful product outcome.

## Correction

The old entrypoint now only inspects legacy metadata, emits explicit
reasons for rejection, and exits nonzero. It does not load credentials,
execute repositories, invoke models, or overwrite results. Legacy rows
are retained with invalid status, manifest origins are explicitly
unverified, and local raw outputs are ignored by Git.

The replacement evidence requirements and available real test commands
are documented in [the quarantined corpus README](https://github.com/Mariotutal/lesscode/blob/master/eval/live-corpus-30/README.md).
No replacement 30-project live evaluation has been completed by this
correction. Public hosted readiness remains subject to the outstanding
work in [the architecture hardening plan](architecture-hardening-plan.md).

## Validation of this correction

The actual suite passed **231 tests across 22 files**, including three
new quarantine regressions, packaged CLI, official MCP SDK, and hosted
HTTP tests. Build, typechecking, and lint passed. The maintained scripted
corpus matched all ten expected verdicts. The initial sandboxed run was
stopped after loopback HTTP was denied and fixture dependency installs
stalled; the complete permitted rerun is the basis for these counts.
No live provider evaluation was run for this correction.

The maintained mutation test also explicitly reports
`error-path-swallow: NO CHECK CAUGHT THIS MUTATION`. This is a confirmed
limit of test-based verification: passing tests, types, and lint do not
prove semantic equivalence. Neither the withdrawn audit nor the passing
suite removes that limitation.
