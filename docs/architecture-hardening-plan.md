# Architecture hardening plan

Keep one engine and one versioned RunRecord. Deliver and verify these phases:

1. Trust/configuration: reject authority from untrusted preloaded config; bound config discovery; resolve both clients before models; snapshot environment/provenance; reject redirects.
2. Adapters: compiled CLI writes the real record atomically without changing repository config. Portable skill calls it. Official MCP SDK, strict inputs, host-selected execution, authenticated bounded HTTP, real SDK-client tests.
3. Hosted contracts: explicit supported source types, durable idempotency with request-conflict rejection, annotations independent of patch offers.
4. Assurance: PR CI for typecheck/lint/build/tests/docs/package; fake provider fixtures; container resource/smoke checks.
5. Infrastructure: API separated from disposable worker hosts; transactional queue with leases and tenant scope, artifact storage/retention, cancellation and rollback. Production cutover requires operator acceptance. Keep single-process store limits explicit until migration is implemented.
6. Provider expansion: ModelClient capability contract and native protocol adapters with fixture tests before advertising compatibility.

PR evidence must distinguish implemented phases from remaining work. Targeted passing tests alone do not establish production readiness.

## Implemented in this branch

- Trust regression covered with fake credentials; preloaded configuration no longer authorizes endpoints/env lookups. Discovery is bounded at engine entry and rejects escaping symlinks. Both roles resolve before Spark from one environment snapshot. Non-secret source/model provenance and SHA-256 configuration identity are recorded. Redirects and secret-bearing response errors are handled defensively.
- Shared strict review input and RunRecord envelope. Compiled CLI writes a real result atomically, respects exit codes and never overwrites repository config. Portable skill uses the installed command. Official MCP SDK with interoperability tests for in-memory and authenticated HTTP clients, root confinement, isolation, capacity/deadline limits and nullable failed-run revisions.
- Durable idempotency with conflict rejection and restart tests; supported hosted contract explicitly GitHub-only; annotations independent of patch offers; role/model cost attribution and incomplete usage corrected.
- PR CI, container builds/smokes, restricted package contents, docs and migration guide. ModelProtocol permits native API adapters without changing engine orchestration.
- Separate API-to-worker delegation with private HTTPS, no model/GitHub credentials or Docker socket on API host, immutable request polling and restart deduplication. Container sources and rollback instructions supplied.

## Remaining before a public multi-tenant deployment

- Transactional shared scheduler with tenant-bound ownership, leases/fencing, remote cancellation and per-tenant quotas. The implemented file store deliberately remains single-process/single-tenant.
- Tenant-authorized artifact storage and retention; production ingress, scoped credential provisioning, measured hostile-code isolation/microVM evaluation and operator cutover.
- Native vendor adapters must be implemented/tested for each supported protocol. Only OpenAI Chat Completions is built in; the adapter interface is implemented and tested with a synthetic native format.
- Dependency audit reports advisories in development/docs tooling (including Vitest/VitePress transitive dependencies); runtime dependencies audited clean during the pruned image build. Upgrade/migrate development tooling separately with test/fixture compatibility validation; do not force npm's suggested unrelated major-version changes.

No production infrastructure or live model requests were used for validation.
