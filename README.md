# LessCode

Review JavaScript and TypeScript changes before they merge.

LessCode gives a developer or coding agent a cited review and, when the deterministic checks accept a supported edit, a proposed patch. It reviews a committed change in a private workspace and leaves the supplied checkout unchanged.

[Install](docs/install.md) · [Run a review](docs/run.md) · [Use MCP or the skill](docs/consumers.md) · [Understand the architecture](docs/architecture.md)

## The short version

```text
committed checkout + comparison base + intended files
                         │
                         ▼
             LessCode review and code checks
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
       cited review              optional patch
                               only when verified
```

The model proposes findings and an edit plan. Code owns scope checks, supported transforms, verification commands, the patch gate, and factual claim verification. Notes are never applied as code.

## See the result shape

This abbreviated example is illustrative. It shows the shape of a canonical result; it is not a transcript from a live provider call.

```json
{
  "state": "completed",
  "verdict": "reviewed",
  "outcome": "review-only",
  "revision": { "headSha": "…", "baseSha": "…", "scope": "declared" },
  "review": {
    "items": [
      {
        "kind": "test-gap",
        "text": "…",
        "verification": { "status": "unverified" }
      }
    ],
    "verification": {
      "verifiedItems": 0,
      "unverifiedItems": 1,
      "withheldItems": 0
    }
  },
  "artifact": null
}
```

`reviewed` means the run completed without returning a patch. It is a successful note-only outcome and exits with status 1. `accepted` means a nonempty patch artifact passed the gate and exits 0. `failed` means the run could not finish and exits 2.

Factual verification is separate from patch acceptance. Supported structured claims are checked against bounded, code-derived evidence and rendered by code. Contradicted or unsupported declared claims are withheld. Other advice is explicitly unverified; a citation proves a location, not every statement made about that location. Read [factual verification](docs/factual-review-verification.md) before treating a review item as established behavior.

## Choose an entrypoint

| You are… | Use… | Result |
| --- | --- | --- |
| Reviewing one local checkout | `lesscode review … --out result.json` | Canonical `RunRecord` written atomically to a file. |
| Connecting an agent | MCP `review_change` | Canonical `RunRecord` in MCP `structuredContent`. |
| Installing a portable agent instruction | `skills/lesscode/SKILL.md` | The skill calls the installed CLI and reads its result. |
| Embedding LessCode | `runReview()` or `review()` | The shared engine or compatibility projection. |
| Reviewing GitHub pull requests | `github-pr-review` | A commit-bound check/comment and optional patch offer. |
| Operating a private service | Hosted job API + worker | Durable GitHub review jobs; publication defaults off. |

All of these paths share one review engine. Execution policy and credentials belong to the operator; fetched source cannot select them.

## Quickstart from source

LessCode is currently a private source/tarball installation, not a published npm-registry package. Node.js 22+, npm and Git are required.

```sh
git clone https://github.com/Mariotutal/lesscode.git
cd lesscode
npm ci
npm run build
node ./bin/lesscode --help
```

Load a provider key through your operator environment or secret store. LessCode does not automatically load `.env`. Then review a committed target checkout:

```sh
export LESSCODE_API_KEY="your-key-from-a-secret-store"

node ./bin/lesscode review \
  --repo /absolute/path/to/target \
  --base HEAD~1 \
  --intent 'src/a.ts,src/b.ts' \
  --tests tests \
  --out /absolute/path/to/results/review.json
```

The target `HEAD` must contain the change, and `--base` must name the commit you actually want to compare. Uncommitted edits are not the review input. The default uses trusted local execution. For source you do not trust, build the approved runner image and add `--execution docker --runner-image lesscode-runner:local`; see [isolated review](docs/run.md#isolated-review).

The installed CLI prints the result path and writes the canonical JSON to `--out`. It never applies the patch to the target branch. Provider-specific configuration, the exact tested Baseten setup, trusted policies and gateway compatibility are in [Providers](docs/providers.md).

## For agents

The agent contract is intentionally small:

- Input: a committed `checkout`, a comparison `base`, nonempty `intent`, and optional `relatedTests`.
- Canonical CLI: `lesscode review|tool` with required `--out`; read the JSON file, not a human summary or exit status alone.
- Canonical MCP tool: `review_change`; execution is selected by the host.
- `accepted`/0 means an accepted patch artifact; `reviewed`/1 is a successful no-patch result; `failed`/2 requires inspecting `state` and `failure`.
- Read `artifact` before discussing or applying a patch. Read `review.items`, `review.facts`, `review.verification`, and `audit.reviewVerification` before describing factual claims.
- Preserve each fact's exact inputs and assumptions. Missing factual metadata in an older record means unknown verification, not success.
- Notes are review output, never patch instructions. Applying an artifact is a separate caller-authorized action.

The portable instruction is [skills/lesscode/SKILL.md](skills/lesscode/SKILL.md). Its host discovery path is intentionally host-specific; LessCode does not claim automatic skill selection in every external agent.

## What LessCode can change

The supported edit set is deliberately closed:

- inline a verified single-use forward;
- retarget a verified duplicate helper to an existing implementation;
- restore program-source scope creep outside declared intent; and
- apply registered mechanical convention fixes.

Tests and sealed fixture paths are protected. The gate checks the prepared tree's tests, typecheck/lint behavior, scope, exports, size and complexity. A passing gate is useful evidence for that patch; it is not a proof of semantic equivalence for all behavior.

## Documentation and status

- [Install, update and uninstall](docs/install.md)
- [Run, results and troubleshooting](docs/run.md)
- [Providers and credential precedence](docs/providers.md)
- [MCP, skill, CLI and library consumers](docs/consumers.md)
- [Private hosted deployment](docs/hosted-deployment.md)
- [Architecture](docs/architecture.md)
- [Factual verification](docs/factual-review-verification.md)
- [Validation and known limits](docs/validation.md)
- [Legacy simplify interface](docs/simplify-tool.md)

Historical measurements, audit corrections and design proposals are linked from the documentation site; they are dated evidence, not a global review accuracy claim. LessCode is licensed under [Apache-2.0](LICENSE). Provider, model, trademark and hosted-service terms remain separate from the repository license.

For contributors, start with [AGENTS.md](AGENTS.md) and [development.md](docs/development.md). For the full documentation site, visit <https://mariotutal.github.io/lesscode/>.
