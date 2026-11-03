# README redesign plan

Status: **implemented in README.md on this branch**. Researched 2026-11-03 against the documentation
refresh merged in PR #45. The implementation changes README.md and does not change runtime
behavior, installation/distribution, dependencies, licensing or deployment.
See [the cited research](readme-research.md) for the five first-party
comparisons. Their observed layouts inform editorial choices; no conversion
or comprehension improvement has been measured for LessCode yet.

## Goal and audiences

Make the repository's entry page answer four questions quickly:

1. What does LessCode do for me?
2. What goes in and what comes back?
3. Which interface should I use?
4. What can I trust about the result?

A developer evaluating the project, an agent invoking it, and a contributor
changing its code need different next steps. The README should identify
those routes and link to authoritative instructions, rather than repeating
all three manuals. In particular, the portable skill is for invoking the
product; AGENTS.md governs contributing to this repository.

## Proposed opening

Draft wording to test, not a shipped README replacement:

> **LessCode — review JavaScript and TypeScript changes before you merge.**
>
> Give developers and coding agents a cited review and, when its checks
> pass, a proposed patch. LessCode reviews committed changes in a private
> workspace and leaves the supplied checkout unchanged.

Follow with direct links to Quickstart, For agents and Documentation, and
a compact status line explaining source/tarball installation and current
local/private operation. Keep internal role names and full gate mechanics
in the later explanation. Do not position a hackathon provider/model as
the product's identity or claim public hosted readiness.

## Proposed README order

| Order | Section | Reader outcome |
| --- | --- | --- |
| 1 | Product promise + short orientation | Recognize a change-review tool, supported languages and proposed output. |
| 2 | One worked example | See committed input, cited feedback and an optional patch before configuring anything. |
| 3 | When to use it | Identify review of generated changes, an agent review step, or a PR workflow as a fit. |
| 4 | Choose your interface | Pick CLI, MCP, portable skill, library or private job API. |
| 5 | Quickstart | Follow one complete supported path and know where the output goes. |
| 6 | For agents | Know inputs, invocation/contract, verdict meanings and verification rules. |
| 7 | What happens during a review | Understand model proposals, code checks, optional patch and unchanged checkout in plain language. |
| 8 | Supported changes, status and limits | Understand the closed transform set and bounded evidence without broad safety/accuracy claims. |
| 9 | Documentation, support and contributing | Reach the correct guide or repository workflow. |

Use descriptive Markdown headings and a small contents/route list. Target
roughly 120–180 lines, but judge it by the reading tasks below rather than
by a hard line count. Plain text must carry essential information even if
an image, badge or GIF does not load.

## Implementation sequence

### 1. Write the orientation and route map

Lead with the job and output. Add a compact table with developer CLI,
agent MCP (`review_change`), portable skill (`skills/lesscode/SKILL.md`),
programmatic and private hosted routes. All share the engine; a protocol
or skill is not another review implementation. Link the existing consumer
and hosted guides rather than publishing five configuration blocks.

Completion: a new reader can identify the product, intended change input,
optional patch and unchanged-checkout behavior from the opening.

### 2. Prepare an honest worked example

Select one representative checked-in fixture or sanitized real artifact.
Show a small supported edit, its cited note, and an accepted versus
note-only outcome. If using a fixture with scripted model responses,
label that explicitly; it demonstrates mechanics, not real model quality.
An illustrative before/after is also acceptable when plainly labeled.
Do not invent a terminal transcript, a full valid RunRecord, an accuracy
percentage or a claim that a patch always survives. Mark a shortened JSON
view as an excerpt and link to its full provenance when available.

Prefer a short text example and a simple input → review → optional patch
workflow. A recording/image is optional after the text works, with alt text
and equivalent readable content. A recorded CLI session must show the
actual output-path interface, not a fictional human-summary UI.

Completion: every shown artifact has known provenance or an illustrative
label, and its asserted outcome agrees with the implementation.

### 3. Offer one complete quickstart

Reuse the tested source-build path and public CLI. State Node 22+, Git/npm,
committed target HEAD, real comparison base, scope and result destination.
Expose the operator key/configuration precondition and local-versus-Docker
execution choice. Keep the tested Baseten example as a clearly identified
provider option or link; alternatives belong in Providers.

Preserve the private-package constraint: source/tarball is supported today;
`npm install -g lesscode` from a registry is not this release path. Keep
update/uninstall, policy precedence, secrets handling and host setup in
their full guides. Do not duplicate a competing install manual.

Completion: the command sequence can be followed without guessing an
unpublished package, missing build, model binding or output interface.

### 4. Add a compact agent contract

Use a short structured block/table, referencing the actual skill and schema:

- Inputs are committed checkout, comparison base, intent and optional tests.
- MCP uses review_change; CLI review/tool requires --out and prints a path.
- Read the canonical JSON rather than inferring success from a path.
- Accepted/0 means an accepted artifact; reviewed/1 is a successful no-patch
  outcome; failed/2 requires inspecting state/failure.
- Preserve item verification, assumptions and inputs. Citations do not
  certify arbitrary narrative; older missing metadata is unknown.
- Notes are never applied. Applying a patch requires caller authorization.
- Execution and credential authority belong to the operator, not fetched source.

Point contributing agents to AGENTS.md separately. Describe MCP/skill
availability without claiming that every external host discovers or
selects the skill automatically. Use semantic headings and actual paths;
no essential instructions only in an image or collapsible panel.

Completion: an agent can select the right interface and interpret reviewed
and unverified advice correctly without reading implementation internals.

### 5. Finish with evidence and maintainable links

Summarize the four supported transform families and the difference between
patch checks and bounded factual verification. Link to architecture,
factual verification, validation and the install/use/provider guides.
Keep current status visible and measured results dated. Historical audit
logs and proposals remain in the documentation, not the main onboarding
route. CI/docs links can provide real maintained signals; do not add a
stable npm release, license, universal safety or accuracy badge without
supporting project state.

The local root currently has no license file and package metadata has no
license field. Flag a maintainer decision before adding an open-source or
license declaration. Do not silently choose one as a documentation edit.
Use the existing issue/PR workflow for support/contribution links; avoid
inventing a community channel or a missing CONTRIBUTING.md target.

## Acceptance checklist

- A newcomer can explain purpose, input and output after the opening.
- The first section contains a concrete example and a route to trying it.
- CLI, MCP and skill choices are visible and distinguish invocation from
  installation, transport and host discovery.
- A fresh reader/agent rehearsal covers: human first review, agent tool
  invocation, and contributor work. Score the answers against the current
  contract; a rehearsal is not evidence of real host skill discovery.
- One quickstart is syntax-checked and smoke-tested without unnecessary
  model spending. Essential setup preconditions are explicit.
- Examples preserve accepted/reviewed/failed meanings and factual scopes.
- Links/anchors and GitHub-rendered text work; images are optional for comprehension.
- Claims, badges, distribution and compatibility match the source revision.
- Detailed guides remain authoritative; README links point to them rather
  than creating stale copies of policy or protocol specifications.

## Deliverables and scope

Implemented here: README rewrite, one explicitly illustrative result
example, and links to the detailed guides. The recent detailed-guide
refresh remains intact. Links, Markdown, the README shell examples and the
documentation build have been validated. The next review step is a human
newcomer/agent rehearsal of the page; it is not a runtime or model-quality
test.
No dependency/SDK migration, npm publication, license choice, infrastructure
change or live accuracy campaign is required by this README redesign.
