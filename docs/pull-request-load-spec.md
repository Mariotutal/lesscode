# Load a pull request, then review it

This spec described `master` at `bee7949`, before the review engine. The load step it proposed shipped in pull request 25 and is now [architecture.md](architecture.md). The page below is the proposal as it was written, not the current behavior.

LessCode reviews one JavaScript or TypeScript change. This document records how a run works today, which file owns which job, and the one change that lets a pull request run without `lesscode-pr.json`.

## Current approach

The product function is `review(checkout, base, intent)`. It returns the gate-accepted patch and a cited note. The patch is applied only inside a scratch worktree. The caller’s branch is left as it was. The note is never applied and never counts as a passing check.

A run needs three inputs that a person supplies today:

- `checkout` is a git tree whose `HEAD` is the change.
- `base` is the git ref that tree is diffed against.
- `intent` is the list of files the change claimed to touch. A changed file outside that list is scope creep. The list may name a file, a directory, or a glob.

`simplify(checkout, base, intent)` is the engine under `review()`. `review()` calls it once, then filters the note. The eight commands are adapters over those two functions. They do not contain a second set of rules, except `npm run plan`, which is the spare engine below.

### What one review does

1. Resolve `HEAD`. Copy it to a detached worktree under `/tmp/lc-simplify-*`. Link `node_modules` when the caller already has one. Record `HEAD` and `git status` and refuse the run if either changed by the end.
2. Diff the worktree against `base`. Drop `package-lock.json` from that list.
3. Build the model context with `scopedReviewFiles`: the intent, the changed files, one-hop imports and importers, and the related tests. JavaScript neighbours are included only when the repo’s `allowJs` is on. The changed JavaScript files themselves are always visible. `checkJs` is only reported. Sealed paths are never listed. If the prompt is larger than the model window, neighbours are trimmed. If the change itself still does not fit, the run fails before any request.
4. Spark (`muse-spark-1.3`) classifies once, through `https://api.meta.ai/v1`, with `tool_choice` `"auto"` and one tool, `report_findings`. A schema failure retries once. A second failure keeps nothing from the model. Transient HTTP 429 and 5xx retry at most twice. The prompt text and the credential are not stored. The manifest stores SHA-256 hashes, model ids, call counts, token totals, and phase times.
5. Code then decides what the model is not allowed to decide. Scope creep is every changed path outside the intent, with the exemptions below. A convention is applied only when `lesscode-conventions.json` at the checkout root names it and an enabled ESLint rule can fix it. Anything else in that family becomes a note. A citation that misses is dropped, unless exactly one declaration of the named symbol exists in the file the model already named. In that case the citations are rewritten and the finding is marked recovered. Zero matches or more than one match drops the finding. Sealed paths are never recovered.
6. Wonder (`muse-wonder-1.0`) is called once. It returns the edits and the note together. An invalid plan produces no edits. There is no second planning call.
7. Code applies each edit in the scratch tree. The actions are `inline`, `retarget`, `restore-from-base`, and `convention-fix`. Inline and retarget are AST codemods. A transform the codemod cannot do is skipped. There is no model-written fallback patch. Scope creep the planner skipped is still restored by code, except on a test path or a sealed path. A test is never deleted.
8. Each kept edit must pass the cheap gate: size drops, cyclomatic complexity of a surviving function does not rise more than 10 percent, exports outside the edit set stay the same, and the edit does not remove or skip a test. The repository’s own test, typecheck, and lint commands run once, on the cumulative kept edits. The default command timeout is 5 minutes. A repository with no `tsconfig` and no typecheck script is not sent to a bare `tsc`. A command that already failed on the untouched tree is a baseline failure, not a reason to reject the edit.
9. The patch text is `git diff` of the scratch tree. Line counts come from git. The caller’s checkout is not modified.

### Verdicts

`review()` returns `accepted` when the patch is non-empty and the gate passed, `reviewed` when the note is the result and nothing was applied, and `failed` only when the run itself cannot finish. An empty intent throws before any model call. Exit codes on every command are 0 for `accepted`, 1 for `reviewed` or `refused`, and 2 for a failed run. The review command prints pretty JSON and then the human summary. A parser has to read the first JSON object only.

`simplify()` still says `accepted` or `refused`. It has no senior note. The agent tool calls `simplify()`, so a tool caller does not receive the note.

### Closed findings

| Finding | Who decides | What code does |
|---|---|---|
| `single-use-abstraction` | Spark, then code verifies the body is a pure forward | Inline with the codemod, or keep the finding and record why there is no patch |
| `duplicate-helper` | Spark, with `existingHelperFile` | Retarget callers to the helper that already exists, or drop it when the bodies are not equivalent |
| `scope-creep` | Code, from the diff minus the intent | Restore the file from `base`, unless it is a test, sealed, or a non-behaviour path |
| `convention-break` | Spark names it; code checks the registry | Apply `semi`, `quotes`, `no-console`, or `no-trailing-spaces` with `eslint --fix` when the repo registered that name and the rule is enabled. Otherwise the note only |

A symbol that other files still import cannot be inlined or deleted unless the edit rewrites those importers. The codemod does that rewrite for retarget. The feature is not reimplemented. Tests are not deleted to satisfy the gate.

On this `master`, `isNonBehaviourPath` exempts documentation, `LICENSE` / `NOTICE` / `CHANGELOG`, and lockfiles. Pull request 24 extends that list to CI, manifests, snapshots, styles, and templates, and changes the reason sentence to one line: the file is outside the intent and is kept because it is not program source. `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.svelte`, `.vue`, and `.d.ts` stay restorable. That pull request is the rule the proposal uses.

### The spare engine

`npm run plan` calls `runPipeline()` in `src/plan/pipeline.ts`. That function classifies, plans, and applies on the checkout it was given, then runs one gate at the end. It does not use the scratch worktree, the per-edit cheap gate, or the manifest. A fix in `simplify()` does not change `npm run plan`. The fixtures and the review command go through `simplify()`.

### What a GitHub command does today

`npm run github-pr-review` requires `--owner`, `--repo-name`, `--pr`, and `--checkout`. The checkout must already exist and must contain `lesscode-pr.json`:

```json
{ "baseRef": "base", "intent": ["src/a.ts"], "relatedTests": ["tests"] }
```

`runPrReview` reads that file, calls `review()` once, and returns two posts. `src/pr/github.ts` writes them. The check is one Check Run named `lesscode/review`. Its body is `JSON.stringify(result.gate)` and its conclusion comes from the gate alone. The comment is one issue comment whose body is the note, marked with `<!-- lesscode:review-note -->`, and a re-run updates it in place. The patch is offered as a new branch `lesscode/suggestions-pr-<n>`, as GitHub suggestion comments, or as text. Default offer is `branch`. The pull-request branch is not updated. The note cannot satisfy branch protection. Tests stub `GithubApi`. No test posts to the real repository.

A pull request that does not contain `lesscode-pr.json` cannot get past `readPrDeclaration`. The fifty open-source cases ran because a harness cloned each pair of commits and passed `intent` itself.

## Current file system

Repository root of `Mariotutal/lesscode`. `src/` is 5,631 lines across 43 TypeScript files.

### `src/classify/` — what the change is

| File | Job |
|---|---|
| `checkout.ts` | Lists source files, reads `tsconfig`, matches intent globs, computes `isNonBehaviourPath`, diffs changed lines, builds `scopedReviewFiles` |
| `classify.ts` | One Spark call, then scope creep, conventions, verification, and recovery |
| `client.ts` | Meta HTTP client, `tool_choice: "auto"`, timeout, and the 429/5xx retry |
| `schema.ts` | Closed finding schema. The model may emit only the three categories above |
| `evidence.ts` | A citation must name a real line. `fixtures/<n>/sealed` is rejected |
| `scopeCreep.ts` | Changed path outside intent becomes `restore-from-base`, unless exempt |
| `verify.ts` | Confirms a single-use body is a forward, and a duplicate body matches |
| `recover.ts` | Moves a citation onto the one matching declaration in the named file |
| `conventions.ts` | Known names, and the names written in `lesscode-conventions.json` |
| `conventionBreak.ts` | Registered practice becomes an edit; anything else becomes a note |
| `eslintFix.ts` | Runs `eslint --fix` for the four mechanical rules |
| `target.ts` | Finds the symbol a citation points at |
| `cli.ts` | `npm run classify` |

`SOURCE_FILE_RE` is `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`. `isSourceFile` excludes `.d.ts`. `.svelte` and `.vue` are not source files for the model context. They are still program files for scope creep: if they sit outside the intent they are restored.

### `src/plan/` — how an edit is made

| File | Job |
|---|---|
| `plan.ts` | One Wonder call. Invalid output means no edits |
| `schema.ts` | Edit actions and note items |
| `apply.ts` | Applies one edit in a tree. Skips a non-mechanical transform. Typechecks only when a `tsconfig` or a typecheck script exists |
| `codemod.ts` | AST inline and retarget. About 794 lines, the largest file |
| `guard.ts` | Rejects an edit that touches a test, a sealed path, or a file outside the finding |
| `snapshot.ts` | Saves and restores file text around one edit. Shared with `simplify()` |
| `pipeline.ts` | The spare engine. Only `cli.ts` calls it |
| `cli.ts` | `npm run plan`. Also requires `--gate-base` |

### `src/gate/` — whether the edit survives

| File | Job |
|---|---|
| `gate.ts` | `evaluateCheapGate` per edit, `evaluateCommandGate` once, `evaluateGate` for both. Reads `package.json` scripts |
| `metrics.ts` | Code lines, excluding comments and blanks, and per-function cyclomatic complexity |
| `symbolGraph.ts` | TypeScript program, `allowJs`, importers, `require()` edges the program does not resolve |
| `cli.ts` | `npm run gate` |

### `src/simplify/` and `src/review/` — the product

| File | Job |
|---|---|
| `simplify/simplify.ts` | The engine described above. 328 lines |
| `simplify/cli.ts` | `npm run simplify`. Prints JSON. Exit 0, 1, or 2 |
| `simplify/index.ts` | Re-exports `simplify` |
| `review/review.ts` | Calls `simplify`, drops a note item whose citation misses, replaces an item that ordered a rejected edit with the gate reason |
| `review/cli.ts` | `npm run review`. Prints JSON, then `summary` |
| `review/index.ts` | Re-exports `review` |
| `manifest.ts` | Shared by classify and simplify. Models, counts, tokens, phase milliseconds, prompt hashes |

### `src/pr/` and `src/tool/` — callers

| File | Job |
|---|---|
| `pr/schema.ts` | `lesscode-pr.json` and the check/comment types |
| `pr/pr.ts` | `readPrDeclaration`, `runPrReview`. Throws if the file is missing or invalid |
| `pr/github.ts` | `GithubApi`, Check Run, comment marker, patch offer |
| `pr/githubCli.ts` | Requires `--checkout` |
| `pr/cli.ts` | `npm run pr-review`. Prints the check and the comment. Does not post |
| `cli/args.ts` | One parser for all eight commands |
| `tool/schema.ts` | Zod for `checkout`, `base`, `intent`, optional `relatedTests` |
| `tool/tool.ts` | Function tool named `simplify`. Forwards into `simplify()` and returns that result, including the old `refused` verdict |
| `tool/cli.ts` | `npm run simplify-tool` |

### Commands in `package.json`

`gate`, `classify`, `plan`, `simplify`, `review`, `simplify-tool`, `pr-review`, `github-pr-review`, plus `test` (`vitest run tests`), `typecheck`, and `lint`.

### Tests, fixtures, eval, docs

`tests/` has one file per area: `classify.test.ts`, `gate.test.ts`, `plan.test.ts`, `simplify.test.ts`, `review.test.ts`, `pr.test.ts`, `github.test.ts`, `tool.test.ts`, `manifest.test.ts`, `snapshot.test.ts`, `eval.test.ts`. The suite uses a scripted model. It does not call Meta or GitHub.

`fixtures/1` through `fixtures/8` each have `base/`, `bloated/`, and `sealed/`. The bloated tree is the pull request. Sealed tests are the oracle. Product code must not read `fixtures/*/sealed`. `fixtures/scripts/verify.sh` is the only runner of those suites. The eight fixtures are: three single-use wrappers, a duplicate `formatMoney`, a button change that also restyles a footer, a load-bearing `SharedApiClient`, a shorter function whose complexity rises, a JavaScript wrapper under `allowJs`, a design note with no patch, and a registered `no-console-log` practice.

`eval/cases/` has ten synthetic checkouts, each with `base/` and `head/`. `eval/score.ts`, `mutate.ts`, `run.ts`, and `run-live.ts` score precision, recall, and verdicts. The recorded live run is in `docs/eval-live-runs.md`. `docs/` also holds the early fixture logs and `simplify-tool.md`. `patches/` holds the hand-written fixture-1 patch the gate tests apply. `scripts/` runs the live fixture batches. `README.md` documents through the GitHub poster and does not yet describe scoped review, the manifest, or citation recovery.

## Proposal

Add one load step in front of `review()`. `review()`, the gate, the classifier, the codemods, and the posting rules stay. The load step’s job is to produce the checkout, the base, and the intent that `review()` already requires.

LES-50 merges first. The load step calls `isNonBehaviourPath` after that extension, so the exemption list lives in one function.

### The value it returns

```ts
interface Change {
  checkout: string;       // scratch clone; the caller does not prepare it for a pull request
  base: string;           // base commit sha
  intent: string[];       // files the change claimed to touch
  relatedTests: string[]; // passed through to review(); omitted when empty, so review keeps its default
  headSha: string;
  changedFiles: string[]; // every path in `git diff --name-only base head`
}
```

Two adapters produce a `Change`.

The local adapter is today’s review command. The caller passes `checkout`, `base`, and `intent`. Related tests stay optional. Fixtures keep using this adapter. Their verdicts stay on the current assertions.

The pull-request adapter takes `owner`, `repo`, and `number`, plus the existing `GithubApi`. It does not take a checkout path.

1. Read the pull request. Record the base sha, the head sha, and the base ref name.
2. Create a scratch directory. Fetch `refs/pull/<n>/head` from the base repository, and fetch the base sha. Check out the head sha detached. This works for a fork pull request because GitHub publishes `refs/pull/<n>/head` on the base repository. The pull-request branch is not checked out and not written.
3. `changedFiles` is `git diff --name-only <baseSha> <headSha>` in that scratch tree. The GitHub files API is not a second list. Pagination and renames stay inside git.
4. Derive `intent` from `changedFiles` with the rules in the next section.
5. If the head contains `lesscode-pr.json`, that file replaces the derived intent. `baseRef` inside it must equal the pull request’s base sha or its base ref name. Any other value fails the run before a model call, with exit code 2. A pull request without the file is the normal case.
6. Call `review()` with that `Change`. Delete the scratch directory when the run finishes, including on failure.

`relatedTests` is left unset on this path. `review()` already defaults it to `["tests"]`, and the gate already runs the repository’s own test script. The load step does not invent a test list.

### How intent is derived

A changed path is in the intent when it is part of the program change:

- It matches `SOURCE_FILE_RE` and does not end in `.d.ts`.
- Or it ends in `.svelte` or `.vue`.
- Or it is a test path: under `test/` or `tests/`, or named `*.test.ts`, `*.test.tsx`, `*.test.js`, `*.test.jsx`, `*.spec.ts`, and the same for the other script extensions already recognised as tests.

A changed path stays out of the intent when `isNonBehaviourPath` is true after LES-50. That covers docs, lockfiles, CI, manifests, snapshots, styles, and templates. `.d.ts` stays out of the intent, so a changed declaration file is still restored, which is the current mocha rule.

A docs-only pull request produces an empty intent. `review()` is not called. The result is `reviewed`, with an empty note, an empty patch, and a summary line that says the pull request changes no program source. Exit code is 1. No Meta call is made.

A GitHub error, a missing pull request, or a fetch that cannot see the base sha fails the run with exit code 2, before a model call. The model client’s retry stays on Meta only.

### What `github-pr-review` becomes

`--checkout` stops being required. The command is:

```text
github-pr-review --owner <o> --repo-name <r> --pr <n> [--offer branch|suggestions|none] [--suggestion-branch <name>]
```

It loads the change, calls the existing `runGithubPrReview` posting path, and still offers the patch as a side branch, suggestions, or text. The check name, the comment marker, the gate-only conclusion, and the refusal to push the pull-request branch stay as they are. `--checkout` remains available for a tree you already have: when it is passed, the command uses the local adapter and still reads `lesscode-pr.json` from that tree. That keeps the current tests able to run without a network fetch.

### Files

New:

| File | Job |
|---|---|
| `src/source/change.ts` | `Change`, and `deriveIntent(changedFiles)` |
| `src/source/local.ts` | Passes a prepared checkout through |
| `src/source/pullRequest.ts` | Fetch, derive, optional `lesscode-pr.json` override, call `review()` |
| `tests/source.test.ts` | The cases below. Scripted model and a stubbed `GithubApi`. No live GitHub and no sealed reads |

Changed:

| File | Change |
|---|---|
| `src/pr/githubCli.ts` | `--checkout` optional. Without it, call the pull-request adapter |
| `src/pr/github.ts` | Accept a `Change` from the loader. Posting stays in this file |
| `README.md` | Document the command without a prepared checkout, and point `lesscode-pr.json` at the optional override |

No existing source file moves. `src/plan/pipeline.ts` stays until a later pass deletes it. A GitHub App, a webhook, and a page are further callers of `src/source/pullRequest.ts`. They are not part of this change.

### Tests that define done

`deriveIntent` keeps `src/a.ts`, `src/a.js`, `src/App.svelte`, `src/App.vue`, and `tests/a.test.ts`. It drops `.github/workflows/ci.yml`, `package.json`, `tsconfig.json`, `pnpm-workspace.yaml`, a `__snapshots__` file, `.snap`, `.scss`, `.html`, `README.md`, and a lockfile. It drops `lib/types.d.ts`.

The pull-request adapter, given a stubbed file list and two fetched commits, calls `review()` once with that intent and the base sha. The scratch directory is gone afterward. No `lesscode-pr.json` is required.

When the head also contains `lesscode-pr.json`, `review()` receives that file’s intent. A `baseRef` that matches neither the base sha nor the base ref name fails before Spark.

A docs-only file list returns `reviewed`, an empty patch, and makes no model call.

Fixtures 1 through 8, run through the local adapter, keep their current verdicts. The GitHub posting test still shows one check, one comment, and an unchanged pull-request branch.

`npx vitest run tests/source.test.ts --pool=forks --poolOptions.forks.singleFork`, then the existing files the same way. `tsc --noEmit` and `eslint src tests` are clean.

### Later, not this change

Retire `runPipeline` and point `npm run plan` at `simplify()`, or delete the command. Point the `simplify` tool at `review()` so an agent receives the note and the `reviewed` verdict. Add a page or a webhook only as another caller of the pull-request adapter.
