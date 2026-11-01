# Run

## Run a local checkout

Use this for a repository you trust. Repository commands run on your machine, with API keys, npm user config, and loader hooks removed from that process.

```bash
npm install
META_API_KEY=... npm run review -- --repo <dir> --base <ref> --intent src/a.ts,src/b.ts [--tests tests]
```

`--intent` is the files the change claimed to touch. `--tests` defaults to `tests`. `--execution docker` runs repository commands in a container instead; the image must already exist.

```bash
docker build -f docker/runner.Dockerfile -t lesscode-runner:local .
```

The model endpoint is `https://api.meta.ai/v1`. `META_API_KEY` is required (`MODEL_API_KEY` and `META_AI_API_KEY` are accepted aliases). `META_API_BASE_URL` overrides the endpoint. Spark is `muse-spark-1.3`. Wonder is `muse-wonder-1.0`, and the engine selects it for the single planning call.

## Review a GitHub pull request

This fetches the pull request head and base by commit, derives the intent from the changed source files, and runs the same engine. Repository commands run in the runner image above. A `lesscode-pr.json` at the head (`baseRef`, `intent`, optional `relatedTests`) overrides that derived intent when its `baseRef` matches the pull request.

```bash
GITHUB_TOKEN=... npm run github-pr-review -- --owner <owner> --repo-name <repo> --pr <n> [--offer none|branch|suggestions]
```

`--offer` defaults to `none`. The command posts one Check Run named `lesscode/review` and one comment marked `<!-- lesscode:review-note -->`. `branch` pushes the verified patch to a new suggestion branch. `suggestions` posts it as review suggestions. The pull-request branch is never modified, and the pull request is never merged. `--checkout <dir>` uses a local tree that already contains `lesscode-pr.json` and matches the pull request head.

## Run the hosted service

The service accepts a job and returns the same record. It does not post to GitHub. The body is only `owner`, `repo`, `prNumber`, and `expectedHeadSha`. A bearer token and an `owner/repo` allowlist are required.

```bash
LESSCODE_SERVICE_TOKEN=... \
LESSCODE_RUNNER_IMAGE=lesscode-runner:local \
LESSCODE_ALLOWED_REPOS=owner/repo \
GITHUB_TOKEN=... \
META_API_KEY=... \
npm run service
```

It listens on `127.0.0.1:8787` unless `LESSCODE_HOST` and `LESSCODE_PORT` say otherwise. `POST /reviews` queues the job. `GET /reviews/<id>` returns its state, and `GET /reviews/<id>/artifact` returns the record when the job has completed.

## Tests

```bash
npm test
npm run typecheck
npm run lint
```

Scripted tests stub the model. A live eval of the corpus is recorded in [docs/eval-live-runs.md](eval-live-runs.md). The agent-facing `simplify` contract is [docs/simplify-tool.md](simplify-tool.md).
