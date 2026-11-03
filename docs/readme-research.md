# README research for LessCode

Reviewed **2026-11-03**. Scope: presentation and navigation patterns for people
and agent consumers. This is research for a plan, not a README rewrite or a
recommendation to change LessCode's runtime dependencies.

## Observed patterns in first-party projects

| Project | What its README does | Pattern worth considering |
| --- | --- | --- |
| [Aider](https://github.com/Aider-AI/aider/blob/main/README.md) | Opens with a plain-language purpose and a screencast; presents concrete capabilities; provides a short installation/invocation path and links to fuller guides. | Explain the user outcome before configuration. Show a recognizable session/result. Keep the first runnable path short. |
| [Ruff](https://github.com/astral-sh/ruff/blob/main/README.md) | States its product category immediately, links docs/playground, places a labeled benchmark graphic near the opening, and separates installation, usage and configuration. | Give readers an immediate product category and visible evidence. Use only evidence LessCode actually has; do not borrow performance claims, testimonials or badges. |
| [reviewdog](https://github.com/reviewdog/reviewdog/blob/master/README.md) | Explains the input-to-review-comment workflow; shows concrete examples/screenshots; organizes formats and local/hosted reporters into explicit sections. | Show how input becomes output, and help readers choose a local, agent or GitHub integration path. Its very long reference-style README is not a length target. |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md) | Identifies the version line, distinguishes client/server packages, supplies a minimal working example and routes readers to tutorials/reference material. | Make compatibility and the intended entrypoint explicit. Keep a minimal complete example and route deeper topics to their authoritative guides. |
| [Anthropic skills](https://github.com/anthropics/skills/blob/main/README.md) | Defines a skill, explains self-contained folders and metadata, distinguishes host-specific usage paths and shows a small skill example. It also distinguishes demonstration material and licensing categories. | Give agents an explicit entrypoint and contract. Distinguish portable instructions from host discovery; avoid claiming automatic compatibility with every host. |

These are observations about the linked READMEs, not evidence that their
formats improve conversion or comprehension for LessCode. The adoption
choices below are editorial recommendations.

The current SDK README describes v2 packages. LessCode's local
`package.json` depends on `@modelcontextprotocol/sdk` **v1** (`^1.32.2`).
Borrow its organization, not its current installation commands or protocol
version claims. Aider/Ruff/reviewdog release-install snippets likewise do
not apply to LessCode's private package.

## Gaps in the current LessCode README

The local `README.md` accurately explains committed input, checkout
preservation, verdicts and bounded factual verification. Its detailed
guides already own setup, providers, consumers and hosting. The remaining
problem is orientation:

- Readers encounter installation and a hackathon-specific provider setup
  before seeing an example review or the situations where it is useful.
- There is no worked input → note → optional patch example showing how
  LessCode differs from a general coding assistant or a linter.
- CLI, MCP, skill, programmatic and hosted paths are mostly buried in a
  guide list rather than an early choice of entrypoint.
- `RunRecord` and the unusual successful exit 1 are described, but agents
  have no compact, early contract identifying inputs, output file, verdict
  authority and factual-verification interpretation.
- The opening has no compact maturity/distribution statement separating
  available local/private operation from public hosted readiness.

Sources for local observations: the checked-out `README.md`,
`docs/install.md`, `docs/consumers.md`, `docs/validation.md` and
[package metadata](https://github.com/Mariotutal/lesscode/blob/master/package.json).
The metadata declares `private: true` and version `0.0.0`; registry release
instructions and a stable-release badge would be misleading today.

The scoped local inventory found no LICENSE/COPYING file, and package
metadata has no license field. Treat licensing as an unresolved maintainer
decision before adding an open-source/license badge. This research does
not select a license or infer a grant from public source availability.

## Recommendations to carry into the plan

1. Lead with one plain sentence identifying the product and outcome,
   followed by an example of the problem it addresses. Keep model-role
   names and implementation vocabulary below that introduction.
2. Put a small, labeled, reproducible worked example near the top: committed
   change, review finding, optional accepted patch, and one note-only
   outcome. Prefer a checked-in fixture or real sanitized artifact. Label
   illustrative output explicitly; do not manufacture terminal evidence.
3. Add an early “choose your path” table for CLI, agent skill, MCP and
   programmatic/private-service consumers, each pointing to its existing
   guide. Distinguish commands from transport and host discovery.
4. Offer one supported quick start. Keep the source/tarball constraint,
   credential precondition and trusted-versus-isolated execution choice
   visible. Put provider-specific variants in the provider guide rather
   than making a temporary hackathon setup the product's identity.
5. Give agents a compact contract: committed checkout/base/intent, canonical
   JSON output, success meanings, unapplied notes, and per-item verification
   metadata. Link the existing skill/schema; do not duplicate a second
   agent instruction manual in the README.
6. Summarize the mechanism and limits in ordinary language, then link to
   architecture, factual verification and measured validation. A passing
   gate is not semantic equivalence, and conditional facts are not full
   coverage proof. Preserve these distinctions without leading with a
   wall of implementation caveats.
7. Finish with current status, contribution/support entrypoints and a small
   documentation map. Add badges only for real maintained signals, and
   decide licensing before presenting a license label.

Acceptance should be based on a newcomer explaining purpose/input/output
after the opening and an agent selecting the right interface without
inventing installation, discovery, verdict or verification behavior.
