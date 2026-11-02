# Run

## Run a local checkout

Use this for a repository you trust. Repository commands run on your machine, with API keys, npm user config, and loader hooks removed from that process.

```bash
npm install
LESSCODE_API_KEY=... npm run review -- --repo <dir> --base <ref> --intent src/a.ts,src/b.ts [--tests tests]
```

`--intent` is the files the change claimed to touch. `--tests` defaults to `tests`. `--execution docker` runs repository commands in a container instead; the image must already exist.

```bash
docker build -f docker/runner.Dockerfile -t lesscode-runner:local .
```

The model endpoint defaults to `https://api.meta.ai/v1` but any OpenAI-compatible endpoint works. Set `LESSCODE_API_KEY` (canonical) and optionally `LESSCODE_API_BASE_URL`, `LESSCODE_SPARK_MODEL`, `LESSCODE_WONDER_MODEL`, or per-role `LESSCODE_SPARK_API_KEY`/`LESSCODE_WONDER_API_KEY`. Deprecated aliases `META_API_KEY`/`MODEL_API_KEY`/`META_AI_API_KEY`, `META_API_BASE_URL`, and `META_MODEL` still work and warn. Default Spark is `muse-spark-1.3` and Wonder is `muse-wonder-1.0`, selected by the engine for the single planning call.

## Per-repo config: `.lesscode.json`

A repository can commit a `.lesscode.json` at its root (loader: `src/provider/configFile.ts`, zod-validated, cached, searched upward from the checkout; schema: `schemas/lesscode.schema.json`, referenced by `$schema`). It pins each role to a named provider without env mutation, e.g. Spark at Meta and Wonder via OpenRouter:

```json
{
  "$schema": "https://lesscode.dev/schemas/lesscode.schema.json",
  "version": 1,
  "providers": {
    "meta": { "baseUrl": "https://api.meta.ai/v1", "apiKeyEnv": "META_API_KEY" },
    "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" }
  },
  "models": {
    "spark": { "provider": "meta", "model": "muse-spark-1.3" },
    "wonder": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4" }
  },
  "pricing": { "anthropic/claude-sonnet-4": { "inputPerMtok": 3, "outputPerMtok": 15 } }
}
```

The file is commit-safe: providers name the env var holding the key (`apiKeyEnv`) only — a literal `apiKey` in the file is rejected, and errors redact secrets. Resolution order is explicit argument > `LESSCODE_*` env > `.lesscode.json` > hardcoded defaults (`muse-spark-1.3` / `muse-wonder-1.0`, `https://api.meta.ai/v1`). `pricing` is optional per-model USD per 1M tokens.

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
LESSCODE_API_KEY=... \
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
