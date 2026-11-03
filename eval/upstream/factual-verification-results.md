# Factual verification results — 2026-11-03

Implementation revision: `4231905` on `codex/factual-claims`.
All live calls used Baseten `meta-models/muse-spark-open-1026` with the
existing request caps and one Spark plus one Wonder call per review.
There was no second model judge or additional Wonder verification call.

## Paired controls

Run: `accuracy-2026-11-03T14-43-59-770Z-8d70bf7f-c1a7-408e-99c1-305dd9d15506`.
Independent Docker probes established the same runtime/assertion facts as
the earlier diagnostic, before invoking the model. The production verifier
itself uses bounded static evidence, not those external probe answers.

| Case | Verified final items | Unverified advice | Withheld items | Checked observation |
| --- | ---: | ---: | ---: | --- |
| Negative branch covered | 1 | 0 | 1 | Returned code-rendered primitive traces; the withheld item lacked a supporting citation. |
| Negative branch uncovered | 0 | 1 | 1 | Advice remains unverified; declared claims with redundant runtime values/missing citations were withheld. No verified coverage-gap claim is asserted. |
| Guarded unbound name | 1 | 0 | 2 | Verified statement says returns:false for the listed inputs and assumptions. |
| Unguarded unbound name | 2 | 0 | 1 | Verified statements preserve the real throws:ReferenceError finding for -1 and 0. Two items repeat the same fact; they are not two independent bugs. |

Eight actual requests used 30,501 tokens. All canonical/provenance checks
passed and no patch was returned. Unsupported declared claims were not
silently treated as correct. The missing-test control does not establish
coverage-gap recall; source presence cannot prove complete coverage or
global absence. Unstructured advice may still contain factual premises
and is explicitly unverified.

## Exact upstream repeat

Run: `2026-11-03T14-43-59-746Z-0f908b97-ea72-4431-9bc3-df961c510bfa`.
The same pinned `is-number-refactor` base/head checks passed before live
engine, official MCP, and CLI invocations. The incompatible is-plain-obj
case was explicitly excluded from this selection.

| Adapter | Verified final items | Unverified advice | Withheld items | Observation |
| --- | ---: | ---: | ---: | --- |
| engine | 0 | 0 | 0 | Returned no notes; this does not establish factual accuracy or recall. |
| MCP | 1 | 0 | 0 | Code-rendered statements correctly describe both benchmark declarations as returning false under the listed primitive inputs/assumptions. |
| CLI | 1 | 0 | 2 | Same correct bounded trace statements; two assertion-source claims lacked supporting citations and were withheld. |

Six actual requests used 64,132 tokens. The three records passed canonical,
revision, Docker, model-ID, call-count, usage and exit-code validation;
all returned reviewed with no patch. The false exception claim was not
published as a verified fact in this run. Runtime observations from the
independent earlier Docker probe agree with the bounded traces.

The source catalog also captured the positive fixture table containing
`'0e+5'` and `'0xff'`. Unit tests verify that declaring such a known-present
input absent is contradicted and withheld. They separately verify a real
reachable ReferenceError, forged IDs, inconsistent evidence, partial
verification and false narrative attached to a true claim.

The live model did not make a contradicted structured declaration in this
sample; the live withheld counts above are unsupported-evidence cases,
not counts of proven false statements. Claims that all hallucinations are
eliminated, all coverage is checked, or overall review quality is verified
would exceed this evidence.

## Artifact policy

Raw records, receipts, source facts, independent probes and process results
are retained privately in the named `.lesscode-eval/` directories. The
catalog binds facts to exact source hashes and is derived only from
supplied source, without reading operator credentials. The verifier does
not persist model request bodies; prompts retain manifest SHA-256s.

See the implementation scope and public result fields in
`docs/factual-review-verification.md`. Older records without factual
verification metadata remain unknown, not retroactively certified.
