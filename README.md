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

Fixtures 1–4 predate the gate; their `package.json` files now also carry the
ESLint dev-deps and `fixtures/eslint.config.mjs` is materialized into fixture
repos so the gate's ESLint step can run there.
