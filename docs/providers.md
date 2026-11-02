# Providers and gateways

LessCode talks to one OpenAI-compatible endpoint per model role. Set one shared key and base URL, or pin each role separately. A committed `.lesscode.json` can pin providers per repository (see [Run](run.md)).

## The contract

Every provider or gateway must accept this and nothing more:

- `POST {baseUrl}/chat/completions` — the base URL is joined with `/chat/completions` (a trailing slash on the base is stripped).
- Request body: `model`, `messages`, and — when tools are sent — `tools` plus `tool_choice: "auto"`. Tool choice is never forced.
- Tools: Spark must be able to call `report_findings`; Wonder must be able to call `propose_surgical_patch` (and return the note in the same call). A gateway that drops tool calls, rewrites tool arguments, or forces a different tool breaks the run.
- Response: standard chat-completions JSON with `choices`, optional `usage` (`prompt_tokens` / `completion_tokens` / `total_tokens`), and `model`. The returned `model` is recorded in the manifest as `responseModels` so you can audit what the gateway actually served.
- Retries: only HTTP `429` and `5xx` are retried (at most twice, exponential backoff). Other statuses fail the call. Each attempt has a 5-minute timeout.

Auth is `Authorization: Bearer <LESSCODE_API_KEY>`. The key is never written to the manifest, the note, or logs; the manifest holds prompt SHA-256 hashes only.

## OpenRouter

```bash
LESSCODE_API_BASE_URL=https://openrouter.ai/api/v1 \
LESSCODE_API_KEY=... \
LESSCODE_SPARK_MODEL=meta/muse-spark-1.3 \
LESSCODE_WONDER_MODEL=anthropic/claude-sonnet-4 \
npm run review -- --repo <dir> --base <ref> --intent src/a.ts
```

`LESSCODE_API_BASE_URL=https://openrouter.ai/api/v1` yields an auditable `response.model` in the manifest: the manifest's `responseModels` shows the model OpenRouter actually routed to, which can differ from the requested id.

## Portkey

Portkey is a gateway in front of a provider; the key and routing live in Portkey, not in LessCode.

```bash
LESSCODE_API_BASE_URL=https://api.portkey.ai/v1 \
LESSCODE_API_KEY=<portkey-api-key> \
LESSCODE_SPARK_MODEL=<provider-model-id> \
LESSCODE_WONDER_MODEL=<provider-model-id> \
npm run review -- --repo <dir> --base <ref> --intent src/a.ts
```

In the Portkey dashboard, create a virtual key for the underlying provider and use that as the model key; Portkey forwards the `chat/completions` call, tools included. This client sends only `Authorization` and `Content-Type` headers, so select the provider through the Portkey virtual key / dashboard config rather than per-request gateway headers. Usage and the served model are visible in Portkey's logs, and the served model also lands in the LessCode manifest as `responseModels`.

## LiteLLM proxy (local)

```bash
# terminal 1 — proxy on http://localhost:4000
litellm --model anthropic/claude-sonnet-4

# terminal 2
LESSCODE_API_BASE_URL=http://localhost:4000 \
LESSCODE_API_KEY=<litellm-master-key-or-any-nonempty-value> \
LESSCODE_SPARK_MODEL=claude-sonnet-4 \
LESSCODE_WONDER_MODEL=claude-sonnet-4 \
npm run review -- --repo <dir> --base <ref> --intent src/a.ts
```

LiteLLM normalises the response to the OpenAI shape, including `usage` and `model`, so cost derivation and `responseModels` work the same as against a direct provider.

## Baseten (mirror / dedicated deployment)

Point the base URL at your Baseten deployment's OpenAI-compatible endpoint and use the deployment's model id:

```bash
LESSCODE_API_BASE_URL=https://model-<id>.api.baseten.co/v1 \
LESSCODE_API_KEY=<baseten-api-key> \
LESSCODE_SPARK_MODEL=<deployment-model-id> \
LESSCODE_WONDER_MODEL=<deployment-model-id> \
npm run review -- --repo <dir> --base <ref> --intent src/a.ts
```

For a mirrored model, keep the mirror's model id in `LESSCODE_*_MODEL`; the manifest's `responseModels` records what the deployment returned.

## Cost

When the provider reports `usage`, the manifest derives `cost` (USD) from per-model pricing: `pricing` in `.lesscode.json` (`inputPerMtok` / `outputPerMtok`, USD per 1M tokens) wins, then the built-in default table for `muse-spark-1.3` / `muse-wonder-1.0`. `renderRunSummary` prints the cost line only when a cost was derived. Cost is informational — it never passes or fails the gate.

## Migrating from META_*

See the migration table in the [README](../README.md#migrating-from-meta_-to-lesscode_).
