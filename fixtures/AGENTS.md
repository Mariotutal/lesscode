# Fixtures — sealed-test rule

`fixtures/<n>/sealed/` is a **harness-only** suite.

- The agent path that edits code (planner, classifier, patch proposer, or any
  code-editing subagent) **must not read, list, open, or copy** anything under
  any `sealed/` directory.
- Only the verification harness / a human reviewer may run the sealed suites,
  via `fixtures/scripts/verify.sh` (which copies `sealed/` into a throwaway
  materialized repo only after checking out the branch under test, never
  into a checkout an editing agent works on).
- Do not import from `sealed/` in `base/` or `bloated/` source or visible tests.
- Sealed tests import the fixture source relatively (`../src/...`) and only
  run inside a materialized bloated-pr checkout (see scripts/verify.sh). They
  are never committed to a fixture branch an editing agent works on.
