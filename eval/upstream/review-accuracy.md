# Review accuracy check — 2026-11-03

## Result: factual accuracy is not established

MCP and the CLI share the same review engine. Their successful execution
does not establish that the senior note is correct. The engine currently
checks whether citations exist and relate to changed lines; it does not
verify the meaning of a claim such as “throws ReferenceError.”

This investigation confirmed the previous false runtime claim and tested
an evidence-guidance prompt candidate. The candidate did not eliminate
the error on the larger upstream input. Its extra instructions were
**removed from the final implementation**, rather than described as an
accuracy improvement. The experiment remains reproducible at commit
`d2faff1a4409c5192d3557caa8ca94745b4c13b4`.

The retained production changes are independently verifiable:

- Explicitly requested JavaScript test context is now included even if
  `allowJs` is false. Previously it could be omitted. Compiler settings,
  including `checkJs`, are not changed. Sealed and unrelated paths remain
  excluded. This issue did not cause the original upstream error: that
  corpus entry already included its test file in its declared intent.
- Planner window checking counts the complete serialized request,
  including the diff, instructions and tool schema. The former estimate
  could overlook a large removed-code diff even when head files were tiny.

Neither change is claimed to make arbitrary note assertions true.

## Paired synthetic holdouts

Run `node --import tsx eval/upstream/accuracy.ts --live` with the same
operator environment documented in the upstream README. It never loads
`.env` or generates model responses from expected answers. Four small
cases independently establish base/head behavior through real Docker
tests and probes, then invoke the actual review engine with real models.
Expected facts are saved beside the records and are not sent to models.

Experiment run:
`accuracy-2026-11-03T13-28-59-615Z-a0b84558-7694-4efa-bbca-fb4afbb5cdd7`.
All calls used Baseten `meta-models/muse-spark-open-1026`, with one Spark
and one Wonder call per case. Eight HTTP requests used 26,835 tokens.

| Case | Independently checked fact | Candidate review observation |
| --- | --- | --- |
| negative-branch-covered | The supplied test explicitly checks negative input rejection. | Acknowledged the existing test; did not say the negative test was absent. |
| negative-branch-uncovered | The supplied test exercises only positive input. | Identified the missing negative assertion and cited the test. |
| guarded-unbound-name | The guarded free identifier falls through and returns false in the normal module environment. | Correctly explained the safe typeof path and pre-existing variable-name problem. |
| unguarded-unbound-name | The head introduces a reachable ReferenceError for zero input, while existing positive tests pass. | Identified both the real exception and the uncovered fallback path. |

These observations show useful discrimination on the targeted facts,
not global note correctness. The cases were constructed independently
of model output, but the failure families were already known; this is
not a broad unseen benchmark. The fee probes cover the stated Number
inputs, not full equivalence for all coercible objects, Symbols or BigInts.
One question in the covered case loosely grouped NaN/non-number no-throw
behavior; such broad wording still needs qualification. Nine notes were
produced overall. No regex accuracy percentage or perfect precision is
claimed. Silence alone would not demonstrate useful detection.

## Larger upstream repeat: the false claim persists

Run: `2026-11-03T13-28-54-931Z-9101ba40-00c7-405e-bf46-374019685f35`.
Same pinned is-number source change and original baseline/head checks;
only `is-number-refactor` was selected. The incompatible historical
is-plain-obj case was explicitly excluded, not marked passed.

| Adapter | Verdict | Notes | Total tokens | Factual review result |
| --- | --- | ---: | ---: | --- |
| engine | reviewed | 4 | 20,018 | Again claims the guarded benchmark code throws ReferenceError: false. |
| MCP | reviewed | 2 | 16,229 | Again claims ReferenceError for the same guarded code: false. |
| CLI | reviewed | 0 | 21,519 | No final notes; this does not prove detection or correctness. |

All three actual adapter invocations passed canonical/provenance checks,
made one Spark and one Wonder call, and applied no patch. Six requests
used 57,766 tokens. The larger input still confused actual control flow
despite correct small-case reasoning. The previous missing-`0e+5` claim
was not repeated in these final notes; that limited observation does not
establish that coverage reasoning is generally fixed.

One MCP candidate item cited a non-source package manifest and was absent
from the final review; the table counts final notes, not raw planner items.
The raw records, independent receipts and human annotations are retained
locally under `.lesscode-eval/` and are excluded from Git.

## What should change next

A citation is location evidence, not factual verification. The next
architecture step should make that distinction explicit:

1. Represent checkable factual claims separately from advice and questions,
   with the asserted behavior, its scope (head behavior versus introduced
   regression), and supporting evidence IDs. Questions containing factual
   premises need the same scrutiny as declarative notes.
2. Supply bounded, independently derived facts to the existing single
   Wonder call. Source/test inventories establish presence, not semantic
   coverage. Runtime probes must remain isolated and their exact scope
   visible; passing one probe must not be generalized to all inputs.
3. Validate claims against those facts after generation and expose whether
   they are supported, contradicted or unverified. Do not silently turn
   a cited statement into a verified statement, ban error keywords, or
   use an agreeing second model as proof. The note remains unapplied.
4. Evaluate claim precision and missed important issues on a larger,
   independently adjudicated pinned corpus. Keep transport success,
   patch safety, empty notes and factual review quality separate.

That semantic verification layer is **not implemented by this change**.
An overall review-accuracy percentage is not supportable from one upstream
change and four targeted synthetic cases.
