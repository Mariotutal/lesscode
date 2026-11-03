# LessCode — agent notes

- Product is `review(checkout, base, intent)` returning `{ applied, review, verdict, findings, gate }`. `applied` is the gate-accepted patch (empty when none survive); `review` is the cited senior note and is not applied. A note-only run is a success.
- Setup and current usage: `docs/install.md`, `docs/run.md`, `docs/consumers.md`. Historical logs/specs are context, not current execution instructions. The installed CLI requires `--out`; development review stdout is a different adapter.
- Factual review verification is separate from the patch gate. Preserve per-item verification, exact inputs and assumptions; unstructured advice and older records without metadata are unverified/unknown. Code owns the fact catalog and verified text; model-declared claims cannot certify prose. See `docs/factual-review-verification.md` and `docs/validation.md`.
- Credentials: model keys come from the environment or the operator's secret store only — canonical `LESSCODE_API_KEY` (per-role `LESSCODE_SPARK_API_KEY` / `LESSCODE_WONDER_API_KEY`), deprecated `META_API_KEY` / `MODEL_API_KEY` / `META_AI_API_KEY` as aliases. A trusted local `.lesscode.json` names only the env var (`apiKeyEnv`), never a literal key. Fetched checkouts cannot choose `baseUrl` or `apiKeyEnv`. Never write a key into a committed file, the manifest, a note, or a log; the manifest holds prompt SHA-256 hashes only.
- Live eval keys for `eval/run-live.ts` follow the same rule: `LESSCODE_API_KEY` in the environment (optionally `LESSCODE_SPARK_MODEL` / `LESSCODE_WONDER_MODEL`, `LESSCODE_API_BASE_URL`), never a key in `eval/` or `docs/`.
- Wonder is called once per run and returns the edit plan and the note together. `tool_choice` stays `auto`. Only 429/5xx are retried.
- JavaScript and TypeScript share one TypeScript program (`allowJs` on); leave `checkJs` as the repository set it.
- Work on a branch and open a pull request; do not push to master and do not merge.
