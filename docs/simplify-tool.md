# Legacy simplify interfaces

`simplify` is the compatibility patch-only projection of the shared `runReview` engine. Use canonical `review_change` or the installed `lesscode review|tool` command when you need the complete note and factual-verification metadata. See [Consumers](consumers.md).

## Interfaces are distinct

| Interface | Result/output |
| --- | --- |
| `lesscode review` or `lesscode tool` | Canonical `RunRecord` written to required `--out`; stdout is the file path. Both names run the same public CLI flow. |
| MCP `review_change` | Canonical `RunRecord` in tool `structuredContent`. |
| Source-level function-calling `createReviewTool()` | Canonical `RunRecord`; not itself an MCP wire server. |
| `simplify()` / `simplifyTool.call()` | Legacy `SimplifyResult`: accepted/refused, patch and audit views. |
| `npm run simplify-tool` | Development adapter for the legacy simplify result; can also print its human summary. Do not parse all stdout as a canonical record. |

The official MCP server registers `review_change`, not a separate legacy `simplify` MCP tool. The function-calling definitions in `src/tool/` are library integrations, not interchangeable transport implementations.

## Arguments

| Argument | Required | Meaning |
| --- | --- | --- |
| `checkout` | yes | Git checkout whose committed HEAD is reviewed. |
| `base` | yes | Actual comparison ref/commit. |
| `intent` | yes | Nonempty array of intended files/directories/globs. Scope-creep rules are code-owned. |
| `relatedTests` | no | Related test paths; defaults to `tests`. |

These arguments carry source identity only. The trusted host selects clients, executor and cancellation. A programmatic integration must choose an isolated executor for source it does not trust; the legacy development CLI is a trusted-local path.

## Legacy result

- `accepted` means a nonempty accepted `patch` exists.
- `refused` means no patch survives; `patch` is empty. This can be a legitimate no-change/unsupported-transform outcome.
- `findings`, `gate`, `plan`, `apply`, `reasons`, registry and manifest fields explain decisions. Raw `plan.review` is diagnostic planner text, not a verified final senior note.
- A failed engine run can throw through this compatibility function; CLI failure exits 2. The ordinary simplify exits are 0 accepted and 1 refused.

The compatibility projection does not expose the full finalized `review.facts` and per-item verification contract. Do not infer factual accuracy from its plan audit. Use `runReview` or `review` when that matters.

All real edits are prepared in a private workspace and returned as patch text. Accepted and refused runs both leave the caller checkout/branch unchanged. A gate-rejected edit is not retried as an arbitrary model-written replacement.
