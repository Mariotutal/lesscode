# Live evaluation runs (LES-27)

Recorded live runs of the eval corpus (`eval/`). Each section is one run: model identifiers, date, and the precision/recall/verdict table. A model change shows up as a diff in these numbers.

The table is the run from that date. The corpus later changed `pre-failing-tests` so a repository whose tests already fail receives `reviewed` and no patch. That later expectation is not written back into the table.

## 2026-11-01 — spark muse-spark-1.3, wonder muse-wonder-1.0

Run at 2026-11-01T00:47:57.201Z with product calls to https://api.meta.ai/v1 (tool_choice auto).

| case | reported | kept | dropped | precision | recall | expected verdict | actual verdict | verdict match | model calls | tokens | time |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | ---: | ---: | ---: |
| inline-basic | 1 | 1 | 0 | 100.0% | 100.0% | accepted | accepted | yes | 2 | 6728 | 25.3s |
| load-bearing-wrapper | 1 | 0 | 1 | 100.0% | 100.0% | reviewed | reviewed | yes | 2 | 6563 | 16.4s |
| duplicate-equivalent | 1 | 0 | 1 | 100.0% | 0.0% | accepted | reviewed | NO | 2 | 6723 | 17.8s |
| duplicate-not-equivalent | 1 | 0 | 1 | 100.0% | 100.0% | reviewed | reviewed | yes | 2 | 6862 | 18.2s |
| scope-creep | 3 | 3 | 0 | 100.0% | 100.0% | accepted | accepted | yes | 2 | 8751 | 35.7s |
| pre-failing-tests | 1 | 1 | 0 | 100.0% | 100.0% | accepted | accepted | yes | 2 | 7515 | 27.7s |
| prompt-injection | 1 | 1 | 0 | 100.0% | 100.0% | accepted | accepted | yes | 2 | 8768 | 37.4s |
| js-no-tsconfig | 1 | 1 | 0 | 100.0% | 100.0% | accepted | accepted | yes | 2 | 6944 | 20.2s |
| convention-registered | 1 | 1 | 0 | 100.0% | 100.0% | accepted | accepted | yes | 2 | 6640 | 28.4s |
| convention-unregistered | 1 | 0 | 1 | 100.0% | 100.0% | reviewed | reviewed | yes | 2 | 7252 | 22.4s |
| **corpus** | 12 | 8 | 4 | 100.0% | 88.9% | — | — | 9/10 | 20 | 72746 | 249.5s |

## 2026-11-02 — LES-54 env-acceptance row (not a corpus run)

`eval/run-live.ts` now resolves both roles through the provider factory (`LESSCODE_SPARK_MODEL` / `LESSCODE_WONDER_MODEL`, shared `LESSCODE_API_BASE_URL`, or `.lesscode.json`). Acceptance check: one live call with `LESSCODE_API_BASE_URL=https://openrouter.ai/api/v1` set — the request reached OpenRouter and was rejected `401 Missing Authentication header` because the only key available in this environment is a Meta key, which is the auditable provider response (the gateway, not the client, refused it). The same client against the default Meta endpoint returned `response.model: muse-spark-1.3`, recorded in the manifest as `responseModels.spark` alongside derived `cost`. No corpus row is appended: a full live corpus run needs a key for the gateway under test.
