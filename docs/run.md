# Run and use LessCode

Complete [installation](install.md) and [provider setup](providers.md) first. Examples use the installed `lesscode` command; from a built source checkout, substitute `node /absolute/path/to/lesscode/bin/lesscode`.

## Select the input

The reviewed input is the target repository's **committed HEAD**, compared with `--base`. Uncommitted and untracked edits are not the review input. The engine creates a private snapshot and leaves the supplied checkout/branch unchanged.

- `--repo`: absolute path to the target Git checkout.
- `--base`: the actual comparison Git ref or immutable commit. `HEAD~1` works only when HEAD has a parent and that is the comparison you intend.
- `--intent`: comma-separated files, directories or globs defining the intended scope. Quote globs to keep the shell from expanding them. Changed program source outside declared intent can be restored from base in the proposed patch; protected and non-behavior paths have separate rules.
- `--tests`: comma-separated related test files/directories; the default is `tests`. Use paths your project's test command accepts. Explicitly requested JavaScript tests can be review context even with `allowJs` off; `checkJs` is not enabled by LessCode.
- `--out`: result JSON destination, preferably outside the target checkout.

## Trusted local review

Ensure the target has its own dependencies installed. Local mode copies supplied dependencies into the private workspace; it does not install them for you.

```sh
lesscode review \
  --repo /absolute/path/to/target \
  --base HEAD~1 --intent 'src/a.ts,src/b.ts' --tests tests \
  --out /absolute/path/to/results/review.json
```

Default execution is local and is appropriate only for source you trust. Repository-owned commands receive the executor's restricted environment rather than model/GitHub credentials, user npm config or loader hooks. Local execution is not a sandbox.

## Isolated review

Build the [runner image](install.md#prepare-docker-mode) first:

```sh
lesscode review \
  --repo /absolute/path/to/target \
  --base HEAD~1 --intent 'src/a.js' --tests test.js \
  --execution docker --runner-image lesscode-runner:local \
  --out /absolute/path/to/results/review.json
```

The image must already exist. The built-in installer supports npm (`npm ci` for a package lock, otherwise install without creating a lockfile), with install scripts disabled. The image is inspected and pinned to its ID; repository commands then run without network access. Missing images and unsupported package managers fail rather than falling back to local execution.

## Interpret the record

The installed CLI writes the `RunRecord` atomically to `--out`, creates parent directories and prints the result path. A setup/argument/output error may prevent a result file; inspect both exit status and the file.

| Verdict | Exit | Interpretation |
| --- | ---: | --- |
| `accepted` | 0 | A nonempty artifact passed the gate on the prepared tree. |
| `reviewed` | 1 | Successful review without a patch; notes may be empty. |
| `failed` | 2 | The run could not complete; inspect `state` and `failure`. |

In a shell with `set -e`, handle exit 1 explicitly:

```sh
review_exit=0
lesscode review --repo /absolute/path/to/target --base HEAD~1 \
  --intent src/a.ts --out /absolute/path/to/results/review.json || review_exit=$?
case "$review_exit" in
  0|1) cat /absolute/path/to/results/review.json ;;
  *) echo "LessCode failed (exit $review_exit)" >&2; (exit "$review_exit") ;;
esac
```

Important fields:

| Field | What to inspect |
| --- | --- |
| `revision` | Head/base SHA and declared/inferred scope; nullable on early failure. |
| `artifact` | Accepted diff, SHA-256, verified tree and paths; null without a patch. |
| `gate`, top-level `verification` | Patch checks and verification status, not review-note accuracy. |
| `review.items[].verification` | Verified code-rendered bounded facts or unverified model advice. Missing metadata in older records means unknown verification. |
| `review.facts` | Source hashes, exact inputs and assumptions supporting factual checks. |
| `review.verification` | Verified, unverified and withheld note counts. |
| `audit.reviewVerification` | Checks for withheld declared claims; not normal published notes. |
| `manifest` | Requested/served models, usage, cost completeness and prompt hashes. |
| `state`, `failure`, `edits` | Execution failure and why edits were kept, skipped, rejected or withdrawn. |

A valid citation proves a location, not the statement's meaning. Verified fact text is rendered by code; contradicted or unsupported declared factual items are withheld. Other advice/questions remain explicitly unverified. Read [factual verification](factual-review-verification.md) before treating an item as established behavior. Presence of assertion source is not complete coverage proof, and a passing patch gate is not semantic-equivalence proof.

## Inspect and apply a patch

LessCode returns patch text; it does not apply it to your branch. Review the artifact and confirm your checkout still matches the recorded head. If you choose to apply it, write `artifact.patch` to a patch file, run `git apply --check /path/to/patch.diff` from the target, and apply it with your normal review workflow. Do not apply `review.items[].text` as code.

## Development command versus installed command

`lesscode review` and `lesscode tool` are the same canonical file-output interface. They require `--out`.

For a built source checkout, the development review entry prints the canonical JSON to stdout and a summary to stderr:

```sh
node dist/review/cli.js --repo /absolute/path/to/target \
  --base HEAD~1 --intent src/a.ts > /absolute/path/to/results/review.json
```

`npm run review -- ...` invokes its TypeScript equivalent; npm may add banners to stdout. Use `npm run --silent review -- ...` or the direct built entry if capturing JSON. The legacy [simplify interfaces](simplify-tool.md) have different output and verdict names; do not substitute them in a canonical-record parser.

## Review a GitHub pull request

From a source checkout, configure model credentials and `GITHUB_TOKEN` (or `GH_TOKEN`), then:

```sh
export LESSCODE_RUNNER_IMAGE=lesscode-runner:local
npm run github-pr-review -- --owner OWNER --repo-name REPOSITORY --pr 123 --offer none
```

This command **publishes** a `lesscode/review` Check Run and a marked issue comment. `--offer none` disables patch offers, not those posts. The token must authorize those GitHub operations and repository access. `branch` creates a separate suggestion branch; `suggestions` posts review suggestions. It never updates the PR branch or merges.

Without `--checkout`, the command fetches immutable PR revisions, derives scope from changed source, and uses Docker with no local fallback. An optional `lesscode-pr.json` (`baseRef`, `intent`, optional `relatedTests`) can override inferred scope only when its base resolves to the actual PR base. Its endpoint/credential settings never gain authority. The command refuses a moved PR head before publication.

`--checkout /path` instead selects a trusted local checkout matching the PR head and containing the declaration. Use that only for source you trust. For queued, non-publishing GitHub review, use the [hosted API](hosted-deployment.md); its artifact is a GitHub outcome envelope containing the canonical record at `run`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Command missing or stale | Follow [install/update](install.md); confirm PATH and rebuild `dist/`. Restart the agent/server. |
| Missing model key or 401 | The control process needs the correct provider key; `.env` is not auto-loaded. Check the provider/model binding without printing the key. |
| Reviewed exit 1 | Normal note-only/no-patch result; inspect JSON rather than treating it as a crash. |
| Base/HEAD resolution error | Commit the change and choose a valid base present in the target checkout. |
| Docker/image/package-manager failure | Verify the daemon, approved image and npm compatibility; there is no local fallback. |
| No applicable patch | Inspect edit reasons/gate, supported transforms, related-test paths and pre-existing test failures. A note-only result is valid. |
| Unknown cost or missing served model | Inspect usage/model fields and cost completeness; missing price/usage is not zero cost. |
| Notes withheld or unverified | Inspect factual checks and assumptions; this is not a verified claim about complete behavior. |
| Prompt too large | Narrow the review scope or use a supported context configuration; the planner counts the full request before calling a model. |

## Developer diagnostics

The source checkout also has lower-level and compatibility entrypoints. Use each built entry's `--help` for its exact arguments; these are not the installed CLI's `review|tool --out` contract.

| Built entry | Purpose |
| --- | --- |
| `node dist/classify/cli.js --help` | Classification diagnostics; ordinary execution can call Spark and inspect executable project configuration. |
| `node dist/plan/cli.js --help` | Legacy pipeline view; retains `--gate-base` compatibility arguments. |
| `node dist/simplify/cli.js --help` | Legacy accepted/refused patch-only view. |
| `node dist/tool/cli.js --help` | Legacy function-calling simplify adapter. |
| `node dist/gate/cli.js --help` | Direct gate diagnostics; no models, but repository commands execute on the supplied tree. |
| `node dist/pr/cli.js --help` | Local PR-declaration/check-and-comment projection. |
| `node dist/pr/githubCli.js --help` | GitHub publishing CLI. |
| `node dist/review/cli.js --help` | Development canonical JSON stdout adapter. |

The help calls do not perform a review. Lower-level diagnostics are for source you trust and do not all provide the engine's private-snapshot guarantee. Prefer the main isolated review path for untrusted repositories. Development history explains earlier designs, not current command syntax.
