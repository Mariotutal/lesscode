# Providers and credentials

Spark classifies findings; Wonder returns the edit plan and review in **one** model call. They are roles, not mandatory vendors. Configure both with tool-capable models. Two wire formats are built in: OpenAI Chat Completions (the default) and the Anthropic Messages API. Other native vendor protocols require a host-supplied adapter.

## Tested Baseten configuration

Load `LESSCODE_API_KEY` from your operator environment/secret store, then:

```sh
export LESSCODE_API_BASE_URL=https://inference.baseten.co/v1
export LESSCODE_SPARK_MODEL=meta-models/muse-spark-open-1026
export LESSCODE_WONDER_MODEL=meta-models/muse-spark-open-1026
```

For the hackathon key, use exactly `meta-models/muse-spark-open-1026` for both roles. Do not substitute the unsuffixed documentation model name. This endpoint/model combination was used by the recorded live pilots; access still depends on the operator's account/key. A dedicated deployment can have a different endpoint/model: use its documented compatible contract rather than assuming the same URL.

If your operator secret store already exports the vendor-named key, bind it explicitly (only after loading that variable):

```sh
export LESSCODE_API_KEY="${BASETEN_API_KEY:?Load BASETEN_API_KEY from your operator secret store first}"
```

`BASETEN_API_KEY` is not an automatic LessCode alias. A trusted local provider file can alternatively name it through `apiKeyEnv`; service startup still needs the shared canonical key.

LessCode does **not** automatically load `.env`. Put actual keys in the control process environment or secret store, never in a committed file, model note or manifest.

## Anthropic Messages configuration

Load `LESSCODE_API_KEY` from your operator secret store, then select the protocol:

```sh
export LESSCODE_PROTOCOL=anthropic-messages
```

With no endpoint or model set, this uses `https://api.anthropic.com` and `claude-opus-5-5` for both roles. Set `LESSCODE_SPARK_MODEL` / `LESSCODE_WONDER_MODEL` to choose other models, and `LESSCODE_SPARK_EFFORT` / `LESSCODE_WONDER_EFFORT` (`low`, `medium`, `high`, `xhigh`, `max`) to tune reasoning effort; the defaults are `low` for Spark and `high` for Wonder. `ANTHROPIC_API_KEY` is not an automatic alias, and the client never reads `ANTHROPIC_*` variables or a local CLI profile: bind a vendor-named key explicitly, as for Baseten above, or name it with `apiKeyEnv`.

The adapter sends one streamed `POST <baseUrl>/v1/messages` per model call, with `tool_choice: {"type": "auto"}` and a 64K output-token ceiling. It keeps the same transport rules as the default adapter (described under Gateway compatibility below). On the first-party endpoint it also enables the server-side refusal fallback, so `manifest.responseModels` may name the model that actually answered. A response that still ends in a refusal fails the call with a refusal error instead of returning an empty plan.

## Environment configuration

| Shared variable | Per-role override | Meaning |
| --- | --- | --- |
| `LESSCODE_API_KEY` | `LESSCODE_SPARK_API_KEY`, `LESSCODE_WONDER_API_KEY` | Credential for the selected endpoint. |
| `LESSCODE_API_BASE_URL` | `LESSCODE_SPARK_API_BASE_URL`, `LESSCODE_WONDER_API_BASE_URL` | Base URL; `/chat/completions` is appended after trailing slashes are removed. |
| `LESSCODE_MODEL` | `LESSCODE_SPARK_MODEL`, `LESSCODE_WONDER_MODEL` | Requested provider model ID. |
| `LESSCODE_PROTOCOL` | `LESSCODE_SPARK_PROTOCOL`, `LESSCODE_WONDER_PROTOCOL` | `openai-chat-completions` (default) or `anthropic-messages`. |
| `LESSCODE_EFFORT` | `LESSCODE_SPARK_EFFORT`, `LESSCODE_WONDER_EFFORT` | Reasoning effort; sent only by the Anthropic Messages adapter. |

Choose one shared endpoint or separate each role's endpoint/key/model. Use HTTPS for remote providers. A local development gateway can use an operator-selected loopback HTTP URL in environment mode; trusted policy endpoints require HTTPS.

Defaults remain `https://api.meta.ai/v1`, Spark `muse-spark-1.3` and Wonder `muse-wonder-1.0` in code. These are compatibility defaults, not a guarantee of current model/account access. Explicit provider and role selection is recommended for reproducible runs.

## Trusted local configuration

A target checkout you explicitly trust may contain `.lesscode.json` at its root:

```json
{
  "version": 1,
  "providers": {
    "baseten": {
      "baseUrl": "https://inference.baseten.co/v1",
      "apiKeyEnv": "LESSCODE_API_KEY"
    }
  },
  "models": {
    "spark": { "provider": "baseten", "model": "meta-models/muse-spark-open-1026" },
    "wonder": { "provider": "baseten", "model": "meta-models/muse-spark-open-1026" }
  }
}
```

`apiKeyEnv` names a variable; a literal `apiKey` is rejected. Canonical environment fields can override this local file, so remove stale exports when switching configuration modes. Engine config discovery is bounded to the reviewed root and rejects escaping symlinks. The source checkout provides `schemas/lesscode.schema.json` for editor use; runtime validation does not depend on downloading an online schema.

## Operator policy for fetched source

A fetched checkout is untrusted. It cannot choose credential-variable names or endpoints. The host may provide an operator-owned policy outside the checkout, using `LESSCODE_TRUSTED_POLICY_FILE=/absolute/operator/path/policy.json`, or inline JSON in `LESSCODE_TRUSTED_POLICY`:

```json
{
  "version": 1,
  "providers": {
    "baseten": {
      "baseUrl": "https://inference.baseten.co/v1",
      "apiKeyEnv": "LESSCODE_API_KEY",
      "allowedModels": ["meta-models/muse-spark-open-1026"]
    }
  },
  "models": {
    "spark": { "provider": "baseten", "model": "meta-models/muse-spark-open-1026" },
    "wonder": { "provider": "baseten", "model": "meta-models/muse-spark-open-1026" }
  }
}
```

The file contains references, not secrets. A provider entry (here or in a trusted local file) may add `"protocol": "anthropic-messages"` to use the Anthropic Messages adapter for every role that selects it. When policy selects a role, its endpoint and credential binding are authoritative: a checkout may request an allowed alias/model, otherwise policy role defaults apply. Canonical endpoint/model exports do not override that selected policy role. Unknown aliases and disallowed models fail before Spark. Without policy, fetched reviews use the operator environment, not fetched provider definitions.

## Resolution details

Host-supplied clients or complete explicit configurations have their own authority and bypass ordinary environment/file selection. Otherwise a selected trusted policy role is resolved first as described above. Outside that policy path, ordinary environment/file precedence is:

| Field | Highest to lowest |
| --- | --- |
| Endpoint | Canonical role env → canonical shared env → trusted local provider → `META_API_BASE_URL` → code default. |
| Key | Canonical role env → canonical shared env → trusted local `apiKeyEnv` value → `META_API_KEY` → `MODEL_API_KEY` → `META_AI_API_KEY`. |
| Model | Canonical role env → `LESSCODE_MODEL` → `META_MODEL` → trusted local model → code default. |

Legacy model precedence differs from legacy endpoint/key precedence. Prefer a single canonical configuration mode instead of relying on mixed legacy/file settings. Both roles resolve from an environment snapshot before the first model request.

## Gateway compatibility

The built-in adapter sends:

- `POST <baseUrl>/chat/completions` with Bearer authorization and JSON content type.
- `model`, `messages`, `tools`, and `tool_choice: "auto"` when tools are present. Spark uses `report_findings`; Wonder uses `propose_surgical_patch`, including structured factual claims in its review items.
- Expected response fields: `choices`, tool-call arguments/content, and optional `model` and `usage`.

Transport redirects are rejected. Only 429/5xx are retried, at most twice with backoff; each attempt has a five-minute timeout. Wonder is still one planning/review call, not an extra model judge. Gate commands have their own timeouts.

For OpenRouter, LiteLLM, Portkey or another gateway, verify that the specific deployment exposes this contract, preserves tools and accepts Bearer auth. Do not assume a vendor name or base URL supplies compatibility. The built-in protocol adds no vendor-specific routing headers. Header/routing requirements beyond this contract require an operator-owned gateway configuration or protocol adapter, not an invented environment variable.

`ModelProtocol` separates encoding/decoding from retry/cancellation. A trusted host can pass `createModelClient('wonder', { protocol: hostProtocol })`, normalizing output to `ChatCompletionResult`. The Anthropic Messages adapter is built in and is selected with `protocol` (environment, trusted policy provider, or trusted local provider); other native protocols are not. A fetched checkout picks only a policy alias, so it cannot select a protocol. The exported interfaces are at `lesscode/provider`.

## Usage and cost

`manifest.models` identifies requested roles; `manifest.responseModels` records served IDs when reported. Usage and cost have independent completeness. Missing prices or usage are not zero spend. Optional operator pricing is USD per million tokens (`inputPerMtok`, `outputPerMtok`); the default table is limited and not an authoritative provider price feed. Cost is informational, not a gate or hard spending cap. The live pilot has separate request/output bounds described in [Validation](validation.md).

## Migration

| Deprecated | Canonical |
| --- | --- |
| `META_API_KEY`, `MODEL_API_KEY`, `META_AI_API_KEY` | `LESSCODE_API_KEY` or role-specific keys |
| `META_API_BASE_URL` | `LESSCODE_API_BASE_URL` or role-specific base URLs |
| `META_MODEL` | `LESSCODE_MODEL` or role-specific model IDs |

Aliases remain supported and warn once per alias. Canonical variables win in the corresponding environment selection. Service startup currently expects a shared `LESSCODE_API_KEY` (or its legacy `META_API_KEY` fallback), even when you also configure role-specific settings.
