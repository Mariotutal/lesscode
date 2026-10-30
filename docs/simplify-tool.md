# The `simplify` tool contract

One tool another agent can call to run the exact same pipeline as
`simplify(checkout, base, intent)` (LES-5). The tool is a thin adapter:
its handler validates the arguments and forwards them verbatim to
`simplify` (`src/simplify/simplify.ts`) and returns the result
unchanged. There is no second pipeline and no second verdict — the
deterministic TypeScript gate inside `simplify` decides, and the
calling agent **does not re-decide the verdict**.

- Definition: `SIMPLIFY_TOOL_DEF` in `src/tool/tool.ts` (a
  function-calling tool definition, `{ type: "function", function: { name: "simplify", description, parameters } }`).
- Handler: `simplifyTool.call(args)` in `src/tool/tool.ts`;
  `createSimplifyTool()` builds a fresh instance.
- Argument validation: `simplifyToolArgumentsSchema` in
  `src/tool/schema.ts` (zod). Invalid arguments throw before any run.
- CLI adapter: `src/tool/cli.ts` (`npm run simplify-tool`), a thin
  adapter over the tool, not over the pipeline directly.

## Arguments

| Argument       | Type       | Required | Meaning                                                                 |
| -------------- | ---------- | -------- | ----------------------------------------------------------------------- |
| `checkout`     | `string`   | yes      | Path to the PR checkout — a git working tree whose HEAD is the PR head. Never modified by the run. |
| `base`         | `string`   | yes      | Git ref the PR is diffed against (the PR's base).                        |
| `intent`       | `string[]` | yes      | Non-empty list of files the change claimed to touch. Any other changed file is scope creep and is restored from `base` by code. |
| `relatedTests` | `string[]` | no       | Related test files/dirs the gate runs. Defaults to `["tests"]` inside `simplify`. |

## Result

The tool returns the `SimplifyResult` unchanged. The fields a caller
acts on:

- `verdict` — exactly two values:
  - `"accepted"`: the gate accepted the cumulative kept edits; `patch`
    holds the resulting unified diff.
  - `"refused"`: nothing was kept (no applicable findings, the planner
    skipped everything, or the gate rejected). `patch` is `""`.
- `patch` — unified diff of the kept edits vs the checkout HEAD, taken
  from `git diff`; its line count comes from git, never the model.
  Empty when the verdict is `refused`.
- `findings` — the closed finding set: `single-use-abstraction`
  (inline), `duplicate-helper` (retarget to the existing helper),
  `scope-creep` (code-decided from the diff vs `intent`, restored from
  `base` by code), and `convention-break` (mechanical fix or refusal).
- `gate` — the deterministic gate result (`{ accepted, checks, metrics, exitCodes }`),
  or `null` when no edit reached the gate. On an accepted run the gate ran
  the related tests, `tsc`, and ESLint, verified exports outside the
  edit set are unchanged, the code-line size dropped, no changed
  function's cyclomatic complexity rose more than 10%, and no test was
  deleted.

The result also carries audit fields (`droppedFindings`, `plan`,
`apply`, `reasons`) from the run; they explain the verdict, they do not
re-open it.

## Branch rule

A run never modifies the caller checkout or branch: every edit is
applied and gated in a scratch worktree that is removed afterwards,
and the patch is returned as text for the caller to apply as it sees
fit. Therefore **a refused run leaves the caller branch unchanged** —
HEAD and file contents are exactly what they were before the call
(this includes accepted runs: the checkout is untouched either way).
