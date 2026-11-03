# Factual review verification

LessCode verifies a bounded set of structured factual claims in the shared
engine. MCP, the CLI, the portable skill and hosted callers receive the
same canonical result. Patch acceptance and factual review verification
are independent: a `reviewed` run is still successful without a patch.

## Ownership and trust

The model selects edits and notes in the existing single Wonder response,
with `tool_choice: auto`. Code constructs a fact catalog from the pinned
head-source context before that response. The model can reference facts;
it cannot create them or assign verification results.

Each fact carries a deterministic ID, exact source SHA-256, file/line
span, predicate, inputs and assumptions. The engine retains that catalog
through finalization. Source mutation during classification is already
rejected by the engine. Evidence is about head source, not proof that a
change introduced behavior or that the eventual patch has that behavior.

The implementation is a pure module: `collectReviewFacts(sources)` builds
evidence; `verifyReviewItem(item, facts)` checks declared assertions. It
does not open files, call models, execute repository code, or use the host
environment as a source of repository globals.

## Supported facts

### Primitive control-flow traces

A bounded AST interpreter handles a small subset of single-argument,
top-level functions: primitive literals, supported operators, short-circuit
branches, returns, explicit standard error throws, and a few standard
primitive operations. It tries a fixed list of primitive inputs and groups
equal outcomes. It explicitly assumes undeclared names are absent from
runtime globals and standard builtins are unmodified.

For example, with no ambient `num`, the known benchmark helpers' guards
evaluate `typeof num` to `undefined`, skip the guarded reads and return
false. Conversely, a reachable direct read of an absent name establishes
ReferenceError for the listed inputs. These are conditional static traces,
not runtime observations or statements about every possible input.

Imports, closures, getters, arbitrary calls, loops, declarations with
hoisting/TDZ behavior, parse errors, and unsupported constructs are not
guessed. Known ambient names are treated as unknown, not falsely declared
missing. Source/function sizes, traversal and operation counts, input
counts and catalog size are bounded. There is no production `eval`, `vm`,
Function constructor, or execution of extracted source. Tests compare
supported traces against actual JS only on fixed, trusted test programs.

### Assertion-source inputs

The catalog recognizes literal arguments in assertion-shaped source calls
and literals in fixture tables referenced by a `forEach` assertion callback.
It records source presence, including parameterized string cases such as
`'0e+5'`. Comments and unrelated strings are not evidence.

This does not prove that an assertion executes, is enabled, checks the
intended function, or establishes semantic coverage. Fixture mutation and
dynamic test registration remain outside the proof. Absence from the
catalog never proves absent repository coverage. A declared absence claim
for an input that is present in the supplied assertion source is contradicted;
an input without presence evidence remains unverified.

## Claims and publication

Model notes may declare `claims: [{ factId, assertion, value? }]`.
Runtime assertions use canonical tokens such as `returns:false` or
`throws:ReferenceError`. Assertion-source claims use `present` or `absent`
and an exact scalar `value`. Primitive trace inputs are fixed by their
fact ID. Claims must cite their supporting fact's source span.

- A matching claim is checked within the fact's stated scope. The engine
  replaces the model's narrative with a sentence generated from the fact
  and its assumptions. Attaching a true claim to false prose cannot make
  the prose verified.
- A contradicted claim causes the whole note item to be withheld.
- Unsupported predicates, invented fact IDs, missing input evidence,
  mismatched citations, or runtime input overrides also cause the declared
  factual item to be withheld. Partially verified items are not upgraded.
- Advice and questions without structured claims remain available with
  `verification.status: unverified` and a visible Markdown label. They may
  contain factual premises the verifier does not recognize. They are not
  certified by existing citations, the note kind, or a successful run.

The raw planner response remains diagnostic data in the audit. Withheld
claim results are in `audit.reviewVerification`; withheld text is not
published in normal `review.items`. Existing gate-driven note rewrites
and citation/scope checks still run. The note is never applied as a patch.

## Reading the result

`review.items[].verification` identifies checked, code-rendered facts
versus unverified model advice. `review.facts` holds the evidence and its
assumptions. `review.verification` summarizes verified, unverified and
withheld item counts under policy version 1. These fields are separate
from the existing top-level patch `verification`.

The canonical schema explicitly preserves these fields over MCP and CLI
serialization. New fields are additive; older version-1 records without
them have unknown factual verification, not implicit success. The
portable skill instructs its caller to preserve the distinction.

## Scope of the guarantee

This is implemented verification for supported declared claims, not
general natural-language fact extraction or a whole-program theorem
prover. It does not establish complete test coverage, subjective design
quality, absence of bugs, or factual correctness of unstructured advice.
It has no second model judge and makes no additional Wonder call.

The live diagnostic controls and pinned upstream repeat are recorded in
the repository's `eval/upstream/factual-verification-results.md`. A useful
ReferenceError finding must survive verification; simply suppressing all
notes would not establish accuracy.
