# LessCode

LessCode reviews a JavaScript or TypeScript change and returns two things: a cited note, and a patch only when the checks still match that edit. The checkout you pass in is left unchanged. The model classifies and plans; the gate decides whether a patch exists.

The run is [`runReview`](src/engine/run.ts). `review`, `simplify`, and the older plan command are views of that one result. How the run is put together is [docs/architecture.md](docs/architecture.md). The ticket-by-ticket build log is [docs/development.md](docs/development.md).

## What a run returns

`npm run review` prints a `RunRecord` as JSON on stdout and a short summary on stderr.

| Verdict | Meaning | Exit |
|---|---|---|
| `accepted` | The note is present and the patch was verified. | 0 |
| `reviewed` | The note is the result. There is no patch. | 1 |
| `failed` | The run could not finish. | 2 |

A verified patch carries its git diff, the hash of that diff, the Git tree hash, and the paths it touches. `simplify` is the older view of the same run: `accepted` when that patch exists, `refused` otherwise.

## What it will change

The finding set is closed.

- **Single-use abstraction.** Inline it.
- **Duplicate helper.** Retarget calls to the helper that already exists.
- **Scope creep.** Code restores files outside the declared intent from the base commit. The model does not decide this.
- **Convention break.** Apply a mechanical fix only when the repository lists that practice in `lesscode-conventions.json`. Anything else stays in the note.

A symbol other files still reference is not inlined or deleted. Tests are not deleted to make the gate pass. `fixtures/*/sealed/` is never read while editing. If the repository's own tests already fail on the untouched commit, the run reports that and returns no patch.

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

Scripted tests stub the model. A live eval of the corpus is recorded in [docs/eval-live-runs.md](docs/eval-live-runs.md). The agent-facing `simplify` contract is [docs/simplify-tool.md](docs/simplify-tool.md).
