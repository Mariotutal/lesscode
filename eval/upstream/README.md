# Pinned upstream pilot

This is a new evaluator, separate from the quarantined `live-corpus-30`.
The initial manifest contains **one actual upstream change**, the
[is-plain-obj performance PR](https://github.com/sindresorhus/is-plain-obj/pull/16).
The head is `e334e11a580ba92662671e9386ea3b681f7750d2`; its actual parent
is `c49ab092dcfd9bb5af5409cc3d6a1e5cbe443afe`. The MIT license content
at both revisions was verified against the committed SHA-256 hash.
Expected behavior was recorded from source inspection before model use.

## Run

Use Node 22+, Git, npm dependencies, and a preinstalled approved Docker
runner image. Commit tracked changes first: evidence is tied to the
exact evaluator/product commit, manifest hash, build hash, and immutable
local runner image ID. No image is pulled and no `.env` is loaded.

```sh
LESSCODE_RUNNER_IMAGE=lesscode-runner:local npm run eval:upstream -- --baseline
```

Baseline mode makes **no model calls**. It fetches the exact public
commits without executing repository files on the host, verifies the
parent relationship and license hashes, saves the upstream patch, then
runs syntax and upstream tests on both versions through the Docker
executor. Dependency installation disables lifecycle scripts. Test
execution has no network or model credentials. The pilot rejects
symlinks and submodules. Every result must pass before live adapters run.

For live mode, supply these variables from the operator environment:
`LESSCODE_API_KEY`, `LESSCODE_API_BASE_URL` (HTTPS),
`LESSCODE_SPARK_MODEL`, and `LESSCODE_WONDER_MODEL`.
Per-role secret-store configuration and local `.lesscode.json` overrides
are deliberately not forwarded by this evaluator. For the Baseten
hackathon, the operator must select `https://inference.baseten.co/v1`
and `meta-models/muse-spark-open-1026` for both roles.

```sh
LESSCODE_RUNNER_IMAGE=lesscode-runner:local npm run eval:upstream -- --live
```

Each case invokes the actual engine, the official MCP client/server over
InMemory transport, and the built `bin/lesscode` CLI **separately**, in
fresh processes. The portable skill uses that CLI command; this does not
evaluate an agent's skill discovery or selection, nor HTTP MCP transport.
All source-owned execution remains in Docker. There are no scripted
responses or verdict-copying callbacks in these live paths.

Every adapter is limited to four HTTP attempts (including retries), a
32,768-byte JSON request body and 8,192 completion tokens per attempt.
`tool_choice` remains `auto`; only the existing provider's 429/5xx retry
policy applies. The pilot refuses more than three manifest cases.
These are conservative request/output bounds, **not a dollar cap**;
pricing depends on the operator's provider. No automatic fallback occurs.

## Evidence and interpretation

Each invocation gets a unique `.lesscode-eval/<timestamp>-<uuid>/`
directory, ignored by Git. It retains the manifest, source patch and
license text, dependency inventories, baseline/head command results,
canonical adapter records, transport receipts (response model IDs and
usage, never prompts), process results and derived summaries. Files
are private and created without overwriting prior evidence. Records
containing an operator credential are withheld.

Canonical schema validation alone is insufficient: revisions, Docker
identity, provider provenance, unique run IDs, observed response models,
call counts, one Wonder call, exit statuses, and expected verdicts must
agree. Timeouts, missing records, failed baselines and mismatches fail
the run. An exact verdict mismatch is preserved for review, not changed
to match the model. `reviewed` is a successful note-only product result
and has CLI exit status 1.

Passing live mechanical validation still requires human inspection of
notes and any patch. Every top-level summary keeps
`modelQualityEstablished: false`; one upstream change cannot establish
general model quality. There is no claim of 30 evaluated projects.

The upstream revision has no npm lockfile. The runner saves the resolved
dependency inventory for each version; dependency installation is not
fully reproducible. The independent manifest expectations remain
reviewable hypotheses. The product gate's known uncovered-error-path
limitation also remains. Expand the corpus with independently reviewed
source changes and behavior checks rather than copying this answer to
new project names.
