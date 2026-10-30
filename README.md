# lesscode

LessCode: behavior-preserving simplification of TypeScript pull requests. Meta hackathon workspace.

## Gate (LES-2, no model)

Deterministic gate in `src/gate/` — symbol graph (`symbolGraph.ts`), metrics
(`metrics.ts`: code-line size excluding comments/blanks, per-function
cyclomatic complexity via the TypeScript AST), and the gate (`gate.ts`).
No model calls anywhere; the CLI prints a metric struct as JSON and the
verdict lives in exit codes + that struct, never prose.

Accept iff all hold:

- related tests, `tsc --noEmit`, and ESLint on touched files exit 0
- exports outside the edit set are unchanged (symbol graph comparison)
- code-line size drops (comment-only hunks do not count)
- no changed (surviving) function's cyclomatic complexity rises >10%
  (the spec's "cyclomatic sum on changed functions" — a per-function cap, so
  inlining N helpers into one god function cannot hide behind a falling sum)
- the patch removes/skips no test

```bash
npm install
npx tsx src/gate/cli.ts --repo <repo> --base <ref> \
  --edit src/a.ts,src/b.ts --tests tests   # exit 0 accept, 1 reject, JSON on stdout
npm test                                   # proofs below
```

Proofs (in `tests/gate.test.ts`, results in `docs/`):

- Hand-written good patch `patches/fixture-1-good.patch` (inlines the three
  single-use wrappers of fixture 1) — gate **accepts** (`gate-fixture1-result.json`).
- Fixture 5 (`fixtures/5/`): the god-function inline is shorter and public
  tests pass, but `totalPrice` complexity rises 2 → 12 — gate **rejects** on
  cyclomatic complexity alone (`gate-fixture5-result.json`, run via
  `scripts/run-fixture5.sh`).

## Classify findings (LES-3, Spark + evidence)

`src/classify/` is the classifier. `muse-spark-1.3` calls
`https://api.meta.ai/v1` through the guest wrapper (`client.ts`:
`META_API_BASE_URL` / `META_API_KEY`, falling back to `MODEL_API_KEY`),
with `tool_choice: "auto"` and a single `report_findings` tool. Structured
output is validated with zod (`schema.ts`) with exactly one retry on
schema failure; a second failure keeps nothing.

Closed finding set:

- **single-use abstraction** — inline it (model-reported, cited)
- **duplicate helper** — retarget calls to the existing helper (model-
  reported, with `existingHelperFile`)
- **scope creep** — restore those files from the base; **decided by
  code** (`scopeCreep.ts`, from the git diff vs base minus the declared
  PR intent), never by the model (the zod schema rejects it)
- **convention break** — apply a mechanical fix or refuse
  (`conventions.ts` registry + `conventionBreak.ts`); unregistered or
  inapplicable conventions are refused, never guessed at

Every finding must cite lines that exist in the checkout
(`evidence.ts`): a finding whose file is missing, whose citations run
past EOF, or that cites a `fixtures/*/sealed/` path is dropped.
Classifying never reads `fixtures/*/sealed/` — sealed files are excluded
from the file listing, the prompt, and citation validation.

```bash
META_API_KEY=... npx tsx src/classify/cli.ts --repo <dir> \
  [--base <ref> --intent src/a.ts,src/b.ts] [--files src/a.ts]
bash scripts/run-classify-fixtures.sh   # live run over fixtures 1–5
```

Fixture run (`docs/classify-fixture-results.txt`, live Spark): fixture 1
keeps the three single-use wrappers, fixture 2 keeps the duplicate
`formatMoney`, fixture 3 keeps only code-decided scope creep (logger,
footer style, app), fixture 4 keeps no model finding for the
load-bearing `SharedApiClient` (only code-decided creep for its
out-of-intent orders files), fixture 5 keeps nothing. Every kept
finding cites lines that exist; invented-line findings are dropped
(unit-tested in `tests/classify.test.ts` with a stubbed wire).

Fixtures 1–4 predate the gate; their `package.json` files now also carry the
ESLint dev-deps and `fixtures/eslint.config.mjs` is materialized into fixture
repos so the gate's ESLint step can run there.
