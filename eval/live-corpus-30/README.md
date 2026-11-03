# Quarantined 30-case evaluation

**These files do not establish a live 30-project evaluation.** Do not
use their verdict totals or expected-match flags for release decisions.
`results.json` retains the historical observations and original claim,
but its current status is invalid. Entries in `manifest.json` describe
synthetic inspiration with unverified licenses and placeholder SHAs.
The original executable harness remains available in Git at `7951e18`;
it should not be run with credentials.

The entrypoint is now a read-only evidence inspection command:

```sh
npx tsx eval/live-corpus-30/harness.ts
```

It prints a rejection report and exits **1**, including when
`EVAL_LIVE=1` or `EVAL_LIVE_REAL=1` is set. It never loads `.env`,
launches the CLI, calls models, creates repositories, or changes outputs.
An invalid legacy result cannot become valid merely by renaming its
mode or replacing its SHAs.

See [the reviewed defects](../../docs/external-audit-findings.md).
Existing local `out/` files are preserved and ignored; their mere presence
does not prove which program or model generated them.

## Actual tests available today

From the repository root:

```sh
npm test
npm run typecheck
npm run lint
```

`tests/eval.test.ts` exercises the maintained synthetic corpus with
scripted clients, deliberately testing unsafe model proposals. MCP and
packaged CLI have their own integration tests. These are deterministic
product checks; they do not measure real model accuracy on upstream PRs.
The separate `eval/run-live.ts` makes real provider calls over the
maintained **synthetic** corpus. Running it requires operator-provided
credentials and incurs model usage; this correction does not run it.

## Requirements for a replacement upstream evaluation

1. Pin each upstream repo, base and head to verified immutable commits.
   Record the verified license and exact patch. Run fetched code with the
   product's isolated executor, without host credentials. Label any
   constructed mutation as synthetic and preserve its exact diff.
2. Establish baseline/head build and behavior results before model calls.
   Document independent expected findings, permissible patches, and note
   outcomes. Do not generate responses from expected verdicts.
3. Separate scripted checks from real provider runs. Require an explicit
   live opt-in and a bounded case/usage budget. Never auto-load `.env` or
   fall back to scripted responses while retaining a live label.
4. Actually invoke each adapter under test (engine, official MCP client,
   installed CLI/skill command). Save its canonical RunRecord validated
   by `runRecordSchema`; check CLI exit status against its verdict.
   Shared-engine tests are useful but do not prove adapter invocation.
5. Save a unique run directory with evaluator and product commits,
   manifest hash, source revisions, commands, execution policy, observed
   response model IDs/usage, timing, errors, and complete sanitized
   records. Never persist credentials or raw prompts. Do not overwrite a
   prior run or replace adapter records with another adapter's output.
6. Fail on missing cases, invalid envelopes, timeouts, failed baselines,
   mismatches, or absent provenance. Report infrastructure/model failures
   separately from correctness and successful note-only runs. Derive
   summary counts from the saved evidence, not hardcoded booleans.

This replacement has **not** been implemented here. The legacy format
cannot be upgraded into trustworthy live evidence after the fact.
