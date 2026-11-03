# Architecture hardening roadmap

Current shipped behavior is documented in [Architecture](architecture.md), [Install](install.md), [Hosted deployment](hosted-deployment.md) and [Validation](validation.md). This roadmap retains the original phase structure and explicitly separates remaining work.

Keep one engine and one versioned RunRecord. Deliver and verify these phases:

1. Trust/configuration: reject authority from untrusted preloaded config; bound config discovery; resolve both clients before models; snapshot environment/provenance; reject redirects.
2. Adapters: compiled CLI writes the real record atomically without changing repository config. Portable skill calls it. Official MCP SDK, strict inputs, host-selected execution, authenticated bounded HTTP, real SDK-client tests.
3. Hosted contracts: explicit supported source types, durable idempotency with request-conflict rejection, annotations independent of patch offers.
4. Assurance: PR CI for typecheck/lint/build/tests/docs/package; fake provider fixtures; container resource/smoke checks.
5. Infrastructure: API separated from disposable worker hosts; transactional queue with leases and tenant scope, artifact storage/retention, cancellation and rollback. Production cutover requires operator acceptance. Keep single-process store limits explicit until migration is implemented.
6. Provider expansion: ModelClient capability contract and native protocol adapters with fixture tests before advertising compatibility.

PR evidence must distinguish implemented phases from remaining work. Targeted passing tests alone do not establish production readiness.

## Implemented on master

- Trust regression covered with fake credentials; preloaded configuration no longer authorizes endpoints/env lookups. Discovery is bounded at engine entry and rejects escaping symlinks. Both roles resolve before Spark from one environment snapshot. Non-secret source/model provenance and SHA-256 configuration identity are recorded. Redirects and secret-bearing response errors are handled defensively.
- Shared strict review input and RunRecord envelope. Compiled CLI writes a real result atomically, respects exit codes and never overwrites repository config. Portable skill uses the installed command. Official MCP SDK with interoperability tests for in-memory and authenticated HTTP clients, root confinement, isolation, capacity/deadline limits and nullable failed-run revisions.
- Durable idempotency with conflict rejection and restart tests; supported hosted contract explicitly GitHub-only; annotations independent of patch offers; role/model cost attribution and incomplete usage corrected.
- PR CI, container builds/smokes, restricted package contents, docs and migration guide. ModelProtocol permits native API adapters without changing engine orchestration.
- Separate API-to-worker delegation with private HTTPS, no model/GitHub credentials or Docker socket on API host, immutable request polling and restart deduplication. Container sources and rollback instructions supplied.
- Bounded factual review verification now derives source-hashed evidence, checks declared claims and renders verified fact text in code. Other advice is unverified; this is not general semantic verification or full coverage proof. See [the verification contract](factual-review-verification.md).

## Remaining before a public multi-tenant deployment

- Transactional shared scheduler with tenant-bound ownership, leases/fencing, remote cancellation and per-tenant quotas. The implemented file store deliberately remains single-process/single-tenant.
- Tenant-authorized artifact storage and retention; production ingress, scoped credential provisioning, measured hostile-code isolation/microVM evaluation and operator cutover.
- Native vendor adapters must be implemented/tested for each supported protocol. Only OpenAI Chat Completions is built in; the adapter interface is implemented and tested with a synthetic native format.
- Re-run dependency/image audits for each release; earlier pruned-image or development-tool audit observations are dated evidence, not a current vulnerability guarantee. Upgrade development tooling with fixture compatibility checks rather than unrelated forced major-version changes.

The original hardening phase used deterministic/scripted validation without production provisioning. Later bounded live pilots and factual-verification controls are recorded separately in [Validation](validation.md); they do not establish public multi-tenant readiness.
