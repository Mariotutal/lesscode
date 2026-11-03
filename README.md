# LessCode

LessCode reviews a committed JavaScript or TypeScript change. It returns a cited review and a patch only when the deterministic gate accepts the prepared edit. The supplied checkout is left unchanged; review text is never applied as code.

Start with the [installation guide](docs/install.md), then [run your first review](docs/run.md). The [documentation site](https://mariotutal.github.io/lesscode/) contains the same guides; the checked-out documentation matches this revision even if the site deployment has not caught up.

## Install from source

Node.js 22+, npm and Git are required. Docker is required for isolated repository execution.

```sh
git clone https://github.com/Mariotutal/lesscode.git
cd lesscode
npm ci
npm run build
node ./bin/lesscode --help
```

The package is private and is not a published npm-registry release. The [installation guide](docs/install.md) explains creating a tarball and installing the `lesscode` command without changing the global system prefix.

## Configure and review

Supply `LESSCODE_API_KEY` from your operator environment or secret store. LessCode does not automatically load `.env`. For the tested Baseten hackathon configuration:

```sh
export LESSCODE_API_BASE_URL=https://inference.baseten.co/v1
export LESSCODE_SPARK_MODEL=meta-models/muse-spark-open-1026
export LESSCODE_WONDER_MODEL=meta-models/muse-spark-open-1026

node ./bin/lesscode review \
  --repo /absolute/path/to/your-checkout \
  --base HEAD~1 --intent src/a.ts --tests tests \
  --out /absolute/path/to/results/review.json
```

Replace the target paths and select the actual comparison base. The target's `HEAD` must contain the change; uncommitted edits are not the review input. This default executes trusted target-repository commands locally. Use [Docker mode](docs/run.md#isolated-review) for source you do not trust. Model calls incur provider usage.

## Read the result

| Verdict | Meaning | CLI exit |
| --- | --- | ---: |
| `accepted` | A nonempty patch artifact passed the gate. | 0 |
| `reviewed` | Successful review without an applied patch; the note may be empty. | 1 |
| `failed` | The run could not finish; inspect `state` and `failure`. | 2 |

The installed command atomically writes a canonical `RunRecord` to `--out` and prints its path. It never applies the patch to the caller's branch. A `reviewed` exit of 1 is a normal outcome, not an infrastructure error.

Patch checks and review accuracy are separate. Review items carry factual verification metadata: supported structured claims are checked against code-derived evidence and rendered by code; contradicted or unsupported declared claims are withheld. Other advice is explicitly unverified. These bounded checks do not prove whole-program behavior or complete coverage. Read [result interpretation](docs/run.md#interpret-the-record) and [factual verification](docs/factual-review-verification.md).

## Supported edits

- Inline a verified single-use forward.
- Retarget a verified duplicate helper to the existing implementation.
- Restore program-source scope creep outside declared intent, subject to protected-path rules.
- Apply registered mechanical convention fixes; other observations remain review advice.

Tests and sealed fixture paths are protected. A passing gate checks specific properties of a prepared tree; it is not proof of semantic equivalence.

## Guides

- [Install, update and uninstall](docs/install.md)
- [Local and GitHub usage, results and troubleshooting](docs/run.md)
- [Providers, credentials and configuration precedence](docs/providers.md)
- [MCP, portable skill and programmatic consumers](docs/consumers.md)
- [Private hosted API and worker deployment](docs/hosted-deployment.md)
- [Architecture](docs/architecture.md) and [current validation status](docs/validation.md)
- [Legacy simplify tool](docs/simplify-tool.md)
- [Development history](docs/development.md) and [historical live measurements](docs/eval-live-runs.md)

Use canonical `LESSCODE_*` variables. Deprecated `META_*`, `MODEL_API_KEY` and `META_AI_API_KEY` compatibility is documented in the [migration guide](docs/providers.md#migration).
