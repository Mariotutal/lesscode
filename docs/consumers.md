# MCP, skills and other consumers

All supported review paths call the same engine. Prefer the canonical `review_change` or CLI `review|tool` interface when you need the full note, artifact and factual-verification metadata. The [legacy simplify tool](simplify-tool.md) is a patch-only view.

## CLI contract

Build/install using [Install](install.md). The public executable is `bin/lesscode`, which loads `dist/cli/main.js`; `scripts/lesscode.mjs` is a compatibility launcher.

```sh
lesscode review --repo /absolute/path/to/target --base HEAD~1 \
  --intent src/a.ts --out /absolute/path/to/review.json
```

`lesscode tool` has the same canonical behavior. The result is atomically written to `--out`; stdout contains its path. Exit 0 means accepted, 1 means reviewed, and 2 means failed. The command never rewrites repository configuration or applies the patch to the target. See [Run](run.md) for execution modes and reading results.

## Portable skill

The reusable document is `skills/lesscode/SKILL.md` in the source checkout and installed package. Put the installed executable on the **agent process's** PATH, then register/copy the skill according to that host's documented skill discovery mechanism. For example, after choosing the host's actual skill directory:

```sh
mkdir -p /absolute/path/to/host-skills/lesscode
cp /absolute/path/to/lesscode/skills/lesscode/SKILL.md \
  /absolute/path/to/host-skills/lesscode/SKILL.md
```

The directory above is a placeholder, not a universal Cursor/OpenCode/Codex configuration path. A host can also be directed to read the portable file explicitly. The skill uses an installed command rather than depending on this repository's npm scripts, and expects operator credentials in the host environment. Source and installed CLI execution have been tested; automatic discovery/selection in every external agent host has not been established.

The skill instructs callers to read factual verification separately from verdict, preserve listed assumptions, and present unverified advice as needing confirmation. Older records without those fields have unknown verification. Notes are not patches.

## MCP over stdio

Use the official MCP client integration in your host. The built server exposes `review_change` and enforces a host-approved checkout root. From a source checkout:

```sh
export LESSCODE_MCP_ROOT=/absolute/path/to/approved/checkouts
export LESSCODE_RUNNER_IMAGE=lesscode-runner:local
# Supply model credentials/configuration to this process as in Providers.
node /absolute/path/to/lesscode/dist/mcp/cli.js
```

Keep stdout reserved for the MCP protocol; use the built Node entry directly rather than an npm wrapper that prints banners. The approved root must exist. Paths are resolved on the MCP server's machine; a remote client does not upload its local checkout by passing a path. Keep the root as narrow as practical. Relative/symlink escapes and sealed checkouts are rejected. Without an approved image or an explicit trusted-local stdio opt-in, review calls fail rather than selecting local execution.

For a graphical host, configure these launcher fields using the host's own wrapper/schema:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/lesscode/dist/mcp/cli.js"],
  "env": {
    "LESSCODE_MCP_ROOT": "/absolute/path/to/approved/checkouts",
    "LESSCODE_RUNNER_IMAGE": "lesscode-runner:local",
    "LESSCODE_API_BASE_URL": "https://inference.baseten.co/v1",
    "LESSCODE_SPARK_MODEL": "meta-models/muse-spark-open-1026",
    "LESSCODE_WONDER_MODEL": "meta-models/muse-spark-open-1026"
  }
}
```

This is a launcher description, not a universal MCP client config. Use absolute paths; JSON does not automatically expand `$HOME`, shell variables or `~`. Supply the key through the host's secret/environment mechanism, not a committed launcher file. GUI hosts may not inherit your terminal exports. For a tarball installation, locate the MCP entrypoint using [the installed package root](install.md#install-the-command-from-a-tarball).

Only source you explicitly trust should use `LESSCODE_MCP_TRUST_LOCAL=1` with stdio. That mode executes repository commands on the host; it is not a sandbox. Execution policy is never a tool argument.

### Discovery and calls

First connect and list tools; this needs a valid root/configuration but does not itself make a model request. Invoke `review_change` with:

```json
{
  "checkout": "/absolute/path/to/approved/checkouts/target",
  "base": "HEAD~1",
  "intent": ["src/a.ts"],
  "relatedTests": ["tests"]
}
```

The official client receives a `CallToolResult`. A successful tool response contains the canonical record in `structuredContent`; tool errors can use `isError`. Also inspect the record's own `state`, `verdict`, `failure` and review-item verification. A completed tool call does not mean a patch was accepted or every note verified.

## MCP over HTTP

The CLI binds to loopback, uses `PORT` (default 3000), and serves `/mcp`:

```sh
export LESSCODE_MCP_ROOT=/absolute/path/to/approved/checkouts
export LESSCODE_RUNNER_IMAGE=lesscode-runner:local
# Set LESSCODE_MCP_TOKEN to an operator-generated token of at least 32 characters.
node /absolute/path/to/lesscode/dist/mcp/cli.js --http
```

Configure an official Streamable HTTP client with URL `http://127.0.0.1:3000/mcp` and `Authorization: Bearer <token>`. HTTP always requires isolated execution; the trusted-local stdio option is not an HTTP bypass. The server uses stateless POST transport, requires its token, bounds payloads/concurrency and rejects browser Origin headers by default. A programmatic host can supply allowed origins through `createHttpHandler`; the CLI has no origin-allowlist environment switch.

Use a private authenticated HTTPS ingress when crossing hosts. Do not expose the runner's Docker authority through MCP. The separate [hosted job API](hosted-deployment.md) is not the `/mcp` endpoint.

## Programmatic use

Install the local tarball into the consuming npm project (global CLI installation does not make bare imports resolve there):

```sh
npm install /absolute/path/to/lesscode-0.0.0.tgz
```

Then:

```js
import { runReview } from 'lesscode';
import { createDockerExecutor } from 'lesscode/execution';

const executor = createDockerExecutor({ image: 'lesscode-runner:local' });
try {
  const run = await runReview({
    checkout: '/absolute/path/to/target',
    base: 'HEAD~1',
    intent: ['src/a.ts'],
    relatedTests: ['tests'],
    executor,
  });
  // Inspect run.state, run.verdict, run.review and run.artifact.
} finally {
  await executor.dispose(); // caller owns injected executors
}
```

Without an executor the engine defaults to trusted local execution. `review` from `lesscode/review` is the compatibility projection (`applied`, `review`, `verdict`, `findings`, `gate`, plus the canonical record at `run`). `runReview` returns the `RunRecord` directly. Consumer models never re-decide the patch verdict and never promote unverified advice into verified facts.
