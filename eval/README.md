# Evaluation corpus (LES-27)

Eight fixtures prove the mechanics. This corpus measures, on cases
beyond the fixtures, how often Spark reports a finding that is not
there, misses one that is, and how often the gate accepts an edit a
human would reject.

- `cases/<id>/{base,head}/` — new synthetic checkouts with known
  answers. No case reads, copies, or references any
  `fixtures/*/sealed` tree.
- `cases.ts` — the registry: per case, the expected findings, the
  expected verdict, and the scripted Spark/Wonder outputs used in
  `npm test`. The scripts deliberately include false positives
  (a load-bearing wrapper reported as single-use, a non-equivalent
  duplicate reported as a duplicate); code — evidence and the
  LES-20 verifier — is what must drop them, and the score counts it.
- `score.ts` — pure scoring: per case, findings reported (what Spark
  emitted), kept (what survived to the result), and dropped
  (reported − kept), precision and recall over kept vs known
  answers, gate verdict vs expected verdict, model calls, tokens,
  and time. `renderScoreTable` prints the table.
- `mutate.ts` — gate mutations: take an accepted patch, change one
  behaviour the tests do not cover, and state which check, if any,
  catches it. A mutation no check catches is printed as
  `NO CHECK CAUGHT THIS MUTATION`, plainly.
- `run.ts` — materializes a case into a throwaway git repo and calls
  `review(checkout, base, intent)` as a caller would.

## Runs

Scripted (in `npm test`, no live model):

```bash
npx vitest run tests/eval.test.ts --pool=forks --poolOptions.forks.singleFork
```

Live (real Spark + Wonder; appends a dated section with model
identifiers to `docs/eval-live-runs.md`, so a model change shows up
as a diff in the numbers):

```bash
MODEL_API_KEY=... npx tsx eval/run-live.ts
```

The cases: `inline-basic` (true wrapper), `load-bearing-wrapper`
(looks single-use, unwraps an envelope, shared by two features),
`duplicate-equivalent`, `duplicate-not-equivalent` (drops the
rounding guard), `scope-creep` (unrelated restyle restored),
`pre-failing-tests` (tests already fail on the untouched head),
`prompt-injection` (source tries to instruct the model in a
comment), `js-no-tsconfig` (JavaScript, no tsconfig — `checkJs`
stays as the repository set it: off, and is never enabled here),
`convention-registered`, `convention-unregistered` (same practice,
note-only without a registry entry).
