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

## Run it

See [docs/run.md](docs/run.md) for running a local checkout, reviewing a GitHub pull request, running the hosted service, and running the tests. The published site is at https://mariotutal.github.io/lesscode/.
