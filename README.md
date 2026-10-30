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
  (`conventions.ts` catalogue + `conventionBreak.ts`); since LES-17 a
  fix is applied only when the repository also wrote the practice in
  its own registry (`lesscode-conventions.json` at the checkout root).
  Unregistered or inapplicable conventions are refused as edits and
  belong in the review note, never guessed at

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

Fixtures 1, 2 and 5 carry the ESLint dev-deps in their `package.json`
files, and `fixtures/eslint.config.mjs` is materialized into fixture
repos so the gate's ESLint step can run there. (Fixtures 3–4 lack them:
fixture 4's run is expected to be refused before the gate, and fixture 3
is not gate-run.)

## Plan once and apply (LES-4, Wonder + gate)

`src/plan/` runs the full pipeline (`pipeline.ts`, CLI `src/plan/cli.ts`):
Spark classifies, then `muse-wonder-1.0` plans **exactly once per run**
(`plan.ts`: one call, no retry — an invalid plan becomes no edits), code
applies the plan (`apply.ts`), and the deterministic gate decides.

The Planner chooses per finding: `inline` (single-use abstraction),
`retarget` (duplicate helper → existing helper), `restore-from-base`
(scope creep; contents come from git, never the model), `convention-fix`
(mechanical fix applied by code), or `skip` (refuse). Code-side
validation rejects edits that touch tests/sealed paths, files outside
the finding's cited set plus its importers, or whose action does not
match the finding category. It does not reimplement the feature.

Apply runs `tsc` after each edit; on failure it takes **one** Wonder
repair turn carrying the compiler error, then skips that finding
(reverting its files) and gates what remains. A shorter diff is not
success by itself — the gate (tests, tsc, ESLint, exports outside the
edit set, size drop, cyclomatic cap, no test deletion) decides.

```bash
META_API_KEY=... npx tsx src/plan/cli.ts --repo <dir> --base base \
  --gate-base bloated-pr --intent src/a.ts,src/b.ts --tests tests
bash scripts/run-plan-fixtures.sh   # live run over fixtures 1, 2, 4
```

Live run (`docs/plan-fixture-results.txt`): fixture 1 — three inlines,
gate **accepted** (53→33 code lines); fixture 2 — duplicate
`formatMoney` retargeted to `src/lib/formatMoney.ts`, gate **accepted**
(32→25); fixture 4 — Wonder refused both findings (load-bearing
`SharedApiClient`, no proven scope creep), no patch, gate not run.
Fixture 2's `package.json` files gained the ESLint dev-deps (as in
fixtures 1/5) so the gate's ESLint step can run in its checkout.

## Simplify behind one function (LES-5)

`src/simplify/` hides that pipeline behind `simplify(checkout, base, intent)`
(`simplify.ts`, re-exported by `index.ts`). `intent` is **required**: the list
of files the change claimed to touch. It returns
`{ verdict, patch, findings, gate }` (plus plan/apply audit fields and
`reasons`); `patch` is empty when the verdict is `refused`, and its line count
comes from `git diff`, never the model.

Inside: Spark classifies (LES-3), Wonder plans **once** (LES-4, the planner in
`src/plan` is unchanged), and code applies each planned edit one at a time in
a **scratch worktree**, keeping an edit only when the gate accepts the
cumulative result. A dropped edit (e.g. fixture 5's complexity edit) reverts
only its own files, so an earlier gate-accepted edit survives. Apply still
takes its one `tsc` repair turn per edit, then drops that finding. Scope
creep is every diff path outside `intent`, restored from `base` **by code**
(even when the planner skips it); test/sealed creep is never restored, since
tests are never deleted. A symbol other files still reference cannot be
inlined or deleted unless every referencing file is rewritten by the edit
set. The caller checkout/branch is never modified — tests assert HEAD and
file contents are unchanged.

The CLI (`src/simplify/cli.ts`) is a thin adapter over the function: it prints
the result as JSON and exits 0 for accepted, 1 for refused, 2 when the run
itself fails (including a missing/empty `intent`).

```bash
META_API_KEY=... npx tsx src/simplify/cli.ts --repo <dir> --base base \
  --intent src/a.ts,src/b.ts [--tests tests]
npm test   # tests/simplify.test.ts drives simplify() with a scripted model
```

## Lead review (LES-17)

`src/review/` puts `review(checkout, base, intent)` in front of the
current checker. `simplify` is unchanged as the engine underneath; the
new function returns `{ applied, review, verdict, findings, gate }`:

- `applied` — the gate-accepted patch (same string `simplify`
  returns). Empty when no edit survives.
- `review` — the cited senior note (`{ items, markdown }`). It is
  never applied, and it is still returned when the patch is empty: a
  run that returns only the note is a successful review.
- `verdict` — `accepted` when the patch is non-empty and the gate
  passed, `reviewed` when the note is the result and nothing was
  applied, `failed` only when the run itself could not finish
  (e.g. missing `intent`).

One TypeScript program reads both languages: `allowJs` is on in the
symbol graph (an import resolving to a `.js` file is credited by the
checker) and in checkout source listing, while `checkJs` stays
exactly as the repository set it — the gate's `tsc` step runs the
repository tsconfig, and `review` only *reports* that setting in
`detail.tsConfig`. Wonder is called **once** and returns the edit
plan and the note together. Code filters the note: an item whose
citation does not exist is dropped, and an item that orders an edit
the gate rejected is replaced with the gate reason.

A practice is applied only from the repository convention registry:
the repository writes adopted convention names in
`lesscode-conventions.json` at its root (`{"conventions": [...]}`).
The classifier keeps a convention-break finding only when its name is
in that registry and a mechanical fix applies; otherwise the finding
is refused as an edit and surfaces as a `practice` note item.

```bash
META_API_KEY=... npx tsx src/review/cli.ts --repo <dir> --base base \
  --intent src/a.ts,src/b.ts [--tests tests]
npm test   # tests/review.test.ts drives review() with a scripted model
```

Proofs (`tests/review.test.ts`, scripted Spark+Wonder, no live model,
no sealed reads): fixtures 1–5 keep their meaning (the whole suite
passes unchanged); fixture 6 — a JavaScript single-use wrapper under
`allowJs` — is inlined and gate-accepted with `checkJs` reported off;
fixture 7 — a non-mechanical design problem (a receipt boundary that
re-derives the invoice concept) — appears in the note and not in the
patch (verdict `reviewed`); fixture 8 — `no-console-log` written in
`lesscode-conventions.json` — is applied, and the same practice with
the registry removed is only a `practice` note item. A note item
ordering fixture 5's complexity edit is replaced by the gate reason.

## Pull-request review caller (LES-7)

`src/pr/` is the pull-request caller of `review(checkout, base,
intent)` — no second pipeline, and `src/review`, `src/simplify`,
`src/plan`, `src/classify`, and `src/gate` are untouched. A pull
request declares its base ref and intent in `lesscode-pr.json` at the
checkout root (`{ "baseRef": "base", "intent": ["src/a.ts"] }`,
optional `relatedTests`). `runPrReview({ checkout })` resolves
checkout/base/intent from that declaration, calls `review()` once,
and splits the result into the two posts:

- the GATE as a check — `check.body` is exactly
  `JSON.stringify(result.gate)` and the conclusion derives from the
  gate alone (`success` iff the gate ran and accepted, else
  `failure`, including `gate: null` when no edit reached the gate),
  so a failing gate can be a required check;
- the SENIOR NOTE as a comment — `comment.body` is exactly
  `result.review.markdown`. The note carries no conclusion and
  cannot satisfy branch protection; a reviewed-only run (note is the
  result, nothing applied) still posts a failing check when its gate
  is null.

`result.applied` is returned for the caller to apply; this caller
never applies it, never modifies the pull-request branch, and never
merges.

```bash
npm run pr-review -- --repo <dir> [--result <file>]   # thin CLI adapter: prints { check, comment }
npm test   # tests/pr.test.ts drives the caller with a scripted model
```

Proofs (`tests/pr.test.ts`, scripted Spark+Wonder, no live model,
no sealed reads): an accepted fixture (fixture 8's registered
`no-console-log` practice) produces the same `review()` result as
calling `review` directly, with the check body equal to that gate
and the comment equal to that note markdown; a reviewed-only fixture
(fixture 7's cited design note) posts that note as the comment and
the null gate as a failing check. In both, the PR branch HEAD and
working tree are unchanged.

## Simplify as one tool (LES-6)

`src/tool/` exposes that same function as one tool another agent can call:
`SIMPLIFY_TOOL_DEF` (a function-calling definition named `simplify`) plus
`simplifyTool.call(args)` in `src/tool/tool.ts`. The handler validates the
arguments (`src/tool/schema.ts`, zod) and forwards them verbatim to
`simplify` — no second pipeline, and the caller does not re-decide the
verdict. It returns the `SimplifyResult` unchanged: `verdict`, `patch`,
`findings`, and `gate`.

The full contract — arguments, the two verdicts (`accepted` / `refused`,
with `patch` empty on refusal), and the rule that a run leaves the caller
branch unchanged (edits live in a scratch worktree; a refused run in
particular changes nothing) — is in [`docs/simplify-tool.md`](docs/simplify-tool.md).

```bash
META_API_KEY=... npx tsx src/tool/cli.ts --repo <dir> --base base \
  --intent src/a.ts,src/b.ts [--tests tests]   # thin CLI adapter over the tool
npm test   # tests/tool.test.ts drives the tool with a scripted model
```

Proofs (`tests/tool.test.ts`, scripted Spark+Wonder, no live model): the
tool result `toEqual`s the direct `simplify()` result on fixture 2
(accepted, duplicate helper retargeted) and on fixture 4 (refused,
load-bearing client not inlined, caller HEAD and working tree unchanged).

Proofs (`tests/simplify.test.ts`, scripted Spark+Wonder, no live model, no
sealed reads): fixture 1 accepted (wrappers inlined, caller branch
unchanged), fixture 2 accepted (duplicate helper retargeted), fixture 3
restores the paths outside intent from base, fixture 4 refused (load-bearing
client not inlined, empty patch), fixture 5 drops the complexity edit and
keeps the earlier gate-accepted edit. Fixture 3's `package.json` files gained
the same ESLint dev-deps as fixtures 1/2/5 so the gate's ESLint step can run
there.
