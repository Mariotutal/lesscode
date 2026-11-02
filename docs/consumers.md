# Consumers

Deterministic consumer integrations for LessCode.

- Local agent skill: `skills/lesscode/SKILL.md`
- CLI: `bin/lesscode review|tool --out result.json` wrapping `scripts/lesscode.mjs`

Build the installation with `npm run build`. The CLI resolves configuration without writing `.lesscode.json` and atomically writes the canonical RunRecord to `--out`. Exit codes are 0 accepted, 1 reviewed, 2 failed. A note-only review succeeds even though its exit code is 1.

MCP uses the official SDK. Start `node dist/mcp/cli.js` for stdio or add `--http` for the loopback `/mcp` endpoint. Set `LESSCODE_MCP_ROOT` to the allowed checkout root and `LESSCODE_RUNNER_IMAGE` to an approved image. HTTP requires a token of at least 32 characters in `LESSCODE_MCP_TOKEN`; it rejects browser Origins unless explicitly allowed by the host. Local stdio can opt into trusted execution with `LESSCODE_MCP_TRUST_LOCAL=1`. Clients cannot select execution policy.

The hosted API accepts `{owner, repo, prNumber, expectedHeadSha}` only. Archive URLs, local paths and execution settings are rejected. Idempotency keys are durable and reuse with a different request returns 409. The current file store permits a single API process; it is not a shared multi-tenant queue.
