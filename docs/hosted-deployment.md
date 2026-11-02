# Hosted deployment and migration

The API can run on a separate host using `LESSCODE_WORKER_URL` and `LESSCODE_WORKER_TOKEN`. In this mode it needs no GitHub/model keys or Docker socket. `docker/api.compose.yml` is the API deployment source. Terminate TLS at a private authenticated ingress. Never expose the executor daemon.

The execution host runs the existing service CLI without WORKER_URL, with its own service token, repository allowlist, GitHub/model secrets and approved runner image. Only the worker control process receives those secrets; repository containers receive the restricted executor environment. Use a dedicated disposable VM/host and a private HTTPS ingress. Do not share the production/API host Docker daemon with repository jobs.

Both tiers retain bounded durable queues. A restarted API resubmits the immutable PR identity; the worker deduplicates it. API cancellation stops polling, but a submitted remote job can continue until its worker deadline; remote cancellation and transactional leases are required before promising distributed cancellation or multiple API replicas. Keep one API process per data directory. This is a two-host single-tenant deployment, not a multi-tenant platform.

Migration: back up the job directory and operator configuration references; build/test an immutable service image and runner image; start the worker privately; submit a scripted canary; configure API delegation; verify authentication, allowlist rejection, restart recovery and artifact identity; then switch private ingress. Roll back by restoring the previous API configuration/image and backed-up store. Never copy secrets into images or Git.

Before public multi-tenant rollout: migrate job ownership to a transactional queue with tenant-bound immutable identity, leases and fencing; use scoped credentials and per-tenant quotas; put artifacts in a separately authorized object store; implement remote cancellation, retention and auditing; validate microVM isolation for hostile repositories. No production resources are provisioned automatically by this repository change.
