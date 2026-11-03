# Private hosted deployment

The hosted job API reviews GitHub pull requests through the same engine. It is a bounded, durable **single-process/single-tenant** system. A separate API host can delegate to an isolated execution host. This is not a public multi-tenant hosting claim; see [validation and limits](validation.md).

## Choose a topology

| Process | Credentials/authority | Data |
| --- | --- | --- |
| Execution worker | GitHub and model credentials; approved local Docker runner image. | Its private durable job directory. |
| Delegating API | Service token, private worker URL/token, repository allowlist; no model/GitHub keys or Docker socket required. | Its own durable job directory. |

Run the worker on a dedicated disposable VM/host with private authenticated ingress. Repository containers receive the executor's restricted environment, not control-plane secrets. Avoid sharing production/API Docker authority with jobs.

## Start the execution worker

From a built source checkout, prepare the [runner image](install.md#prepare-docker-mode) and [model environment](providers.md). Supply `GITHUB_TOKEN`, a shared `LESSCODE_API_KEY`, and `LESSCODE_SERVICE_TOKEN` through the operator environment/secret store. The service token must contain at least 32 characters.

```sh
export LESSCODE_ALLOWED_REPOS=OWNER/REPOSITORY
export LESSCODE_RUNNER_IMAGE=lesscode-runner:local
export LESSCODE_DATA_DIR=/absolute/private/path/worker-data
export LESSCODE_HOST=127.0.0.1
export LESSCODE_PORT=8787
node dist/service/cli.js
```

Leave `LESSCODE_WORKER_URL` unset on the execution host. Startup requires the shared model key (or legacy `META_API_KEY`) and GitHub token even if you also use role-specific provider settings. No publishing is enabled by the service CLI; the hosted runner's programmatic `publish` option is operator-owned and defaults off.

Optional process settings:

| Variable | Default | Bounds/meaning |
| --- | --- | --- |
| `LESSCODE_CONCURRENCY` | 1 | 1–4 active jobs. |
| `LESSCODE_MAX_QUEUE` | 50 | 1–1000 queued jobs. |
| `LESSCODE_JOB_TIMEOUT_MS` | 900000 | 1–3600000 milliseconds per job. |
| `LESSCODE_DATA_DIR` | `.lesscode-service` | One process owns each directory; preserve it across restarts. |

`LESSCODE_HOST`/`LESSCODE_PORT` configure this job API. They are distinct from MCP's `PORT` variable. The API does not expose an unauthenticated health endpoint; an unauthenticated request should receive 401.

## Submit and retrieve a review

All three routes require `Authorization: Bearer <service-token>`. `POST` also requires JSON content type. The only submission fields are:

```json
{
  "owner": "OWNER",
  "repo": "REPOSITORY",
  "prNumber": 123,
  "expectedHeadSha": "<actual immutable PR head SHA>"
}
```

Replace the SHA placeholder with the actual 40- or 64-digit hexadecimal commit. Local paths, archive URLs, runner settings and publish flags are rejected. A moved head must be resubmitted with its new immutable identity.

```sh
curl --fail-with-body http://127.0.0.1:8787/reviews \
  -H "Authorization: Bearer $LESSCODE_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: review-request-0001' \
  --data @/absolute/path/to/submission.json
```

New jobs normally return 202; an existing immutable request can return 200. Save the returned `id` and poll authenticated `GET /reviews/<id>`. States are queued, running, completed or failed. `completed` means a result is stored, not that its review verdict is accepted. Failed jobs carry an error; resubmission and status must be evaluated against the immutable request.

Authenticated `GET /reviews/<id>/artifact` returns 409 until the job is completed, then the stored **GitHub outcome envelope**, whose `run` field is the canonical `RunRecord`. Read `run.verdict`, `run.failure`, `run.review` and `run.artifact`; do not treat the outer job ID/state as the patch verdict or factual-verification status. Artifact delivery is withheld if artifact keys or strings match a credential in the service's configured redaction set.

Idempotency keys use 8–128 letters, digits, underscores or hyphens. Reusing one for a different request returns 409. Immutable PR identity also deduplicates submissions. The routes have no DELETE/cancel operation.

## Separate API host

Expose the execution worker only through private authenticated HTTPS. On the API host, supply:

- A distinct `LESSCODE_SERVICE_TOKEN` for clients of the API.
- `LESSCODE_WORKER_URL` pointing at the private worker's service base URL, without `/reviews` appended.
- `LESSCODE_WORKER_TOKEN` equal to the worker's service token, at least 32 characters.
- The API's own `LESSCODE_ALLOWED_REPOS` and persistent `LESSCODE_DATA_DIR`.
- A nonempty `LESSCODE_RUNNER_IMAGE` label; it is required at CLI startup even though delegated execution uses the worker's actual image.

The repository supplies `docker/api.compose.yml` for this API tier:

```sh
docker compose -f docker/api.compose.yml config --quiet
docker compose -f docker/api.compose.yml up --build -d
```

The compose file requires the service token, worker URL/token and allowlist from the environment. It mounts persistent API data, binds host loopback port 8787, and does not mount a Docker socket or require GitHub/model secrets. Run it only after provisioning its environment; the commands above create/update real local infrastructure.

For a trusted development loopback worker only, the remote adapter also permits HTTP on localhost/127.0.0.1. Remote worker URLs otherwise require HTTPS and no URL credentials. Keep separate data directories for API and worker.

## Restart, cancellation and rollback

Both tiers retain bounded durable job stores. Startup recovers interrupted work; API resubmission is deduplicated at the worker. Keep one process per data directory. Back up data while the owning process is stopped, along with operator configuration references, approved image identity and source/service revision. Do not copy keys into Git or images.

An API timeout/abort stops polling; a submitted remote job may continue until its worker deadline. There is no distributed cancellation guarantee or public cancel endpoint. A worker deadline aborts its own local job through the executor.

For migration, validate the new private worker first, submit a canary, then configure API delegation and verify authentication, allowlist rejection, restart recovery, artifact identity and review metadata. Switch private ingress only after operator acceptance. Roll back by restoring the previous image/configuration and an appropriate stopped-store backup; never run old and new processes against the same directory.

## Before public multi-tenant operation

A public service still needs transactional tenant-bound job ownership, leases/fencing, scoped credentials, quotas, remote cancellation, tenant-authorized artifact storage/retention, hardened ingress and measured hostile-code/microVM isolation. The current file store and Docker setup do not establish those properties. No production resources are provisioned by installing LessCode.
