# Fixtures 1–4 (LES-1)

Built before any model prompt. No Muse call is involved in this directory.
Each fixture is a small standalone TypeScript/Vitest repo (~15 TS files across
both snapshots) kept as two snapshots in the outer repo and materialized into
real git branches by script:

| Dir | Meaning |
|---|---|
| `fixtures/<n>/base/` | Contents of branch `base` |
| `fixtures/<n>/bloated/` | Contents of branch `bloated-pr` |
| `fixtures/<n>/sealed/` | Harness-only sealed tests — see `AGENTS.md` (editing agents must not read) |

Materialize one fixture (branches `base` and `bloated-pr`):

```bash
bash fixtures/scripts/materialize.sh 1 /tmp/lesscode-fixture-1
```

Verify all four (harness only; installs deps in a temp dir, runs visible tests
on `base`, visible + sealed tests on `bloated-pr`, plus `tsc --noEmit`):

```bash
bash fixtures/scripts/verify.sh
```

Fixtures 6–8 (LES-17) extend the spec for the lead review; they have
no `sealed/` suite (nothing under `fixtures/*/sealed/` was read or
added for them):

6. **JavaScript wrapper** — `src/userApi.js` is a single-use JS
   wrapper under `allowJs` (`checkJs` off). Correct outcome: inline it
   into `src/userLabel.js`, gate accepts.
7. **Design note** — `renderReceipt` re-derives the invoice concept:
   a non-mechanical design problem. Correct outcome: cited in the
   review note, absent from the patch (verdict `reviewed`).
8. **Registry practice** — `console.log` in `src/greet.ts`, with
   `no-console-log` written in `lesscode-conventions.json`. Correct
   outcome: the mechanical fix is applied; with the registry removed,
   the same practice is only a `practice` note item.

## The four fixtures

1. **Wrappers** — `UserApiClient` → `UserRepository` → `UserService` are three
   single-use classes around one `client.get`. Correct outcome: inline all
   three, leaving a `UserFetcher` whose only method forwards to `client.get`
   (that shape is the spec, not a measured line-count result). Sealed check:
   response shape / pass-through and error propagation.
2. **Duplicate** — the PR adds `src/checkout/formatMoney.ts`, reimplementing
   the existing `src/lib/formatMoney.ts`. Correct outcome: delete the copy,
   retarget `checkout.ts` to `../lib/formatMoney.js`. Sealed check: rounding
   edge (`1.005 → $1.01`, `2.675 → $2.68`, negative).
3. **Scope** — a button change (primary class + `aria-label`) also restyles
   `src/styles/footerStyle.ts` and adds `src/logger.ts` (wired into `app.ts`).
   Correct outcome: keep the button change, restore the unrelated paths from
   base (revert `footerStyle.ts`, remove `logger.ts` and its call). Sealed
   check: rendered footer markup matches base; the style-token/logger restore
   itself is a file-level diff against `base`, checked by the gate/reviewer.
4. **Load-bearing** — `SharedApiClient` looks like a wrapper but unwraps the
   `{data, requestId}` envelope and normalises paths; on the bloated branch a
   second feature (orders, alongside users) shares it, and a visible test
   locks the unwrapped shape. Correct outcome: **refuse** — no inline. Sealed
   check: the inlined version fails (callers would receive the raw envelope).

On the bloated branch, visible and sealed tests both pass for every fixture
(verified by `scripts/verify.sh`).

Note: `tsc --noEmit` in `verify.sh` runs on the materialized branch **before**
the sealed suite is executed against it (the sealed copy is present in the
worktree, so the sealed suite is typechecked against the branch it verifies —
which is why fixture 4's sealed test, referencing the bloated-only orders
feature, typechecks on `bloated-pr`).
