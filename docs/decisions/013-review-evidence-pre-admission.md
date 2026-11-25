# ADR-013: Review evidence pre-admission and exhausted-gate handling

- **Status:** Accepted
- **Date:** 2026-11-13
- **Context:** Independent plan review repeatedly rejected an implementation plan
  because the plan over-claimed what its bound assertion observed, described a
  second green run as a counterexample, and bound a faulty variant to only half
  of a conjunction claim. The reviewer was correct in every iteration. The plan
  author continued revising, but the final revision arrived after the review
  budget was exhausted and was therefore never reviewed. The subsequent
  governance override was attempted without a non-empty rationale.

## Context

FlowGuard keeps three distinct authorities:

1. the deterministic claim/evidence contract at the write boundary;
2. the independent reviewer for semantic claim breadth and counterexample
   sufficiency;
3. the human decision at an exhausted review gate.

The three must not be collapsed. A deterministic parser cannot decide whether a
prose claim is broader than a provider-scoped assertion, or whether a described
faulty variant truly falsifies the exact assertion. The reviewer must retain
that authority.

The canonical counterexample rule already states that positive and
counterexample evidence require different checks and different executions, but
do **not** require different assertion identities. The same regression assertion
may serve as the falsification witness when it fails on the targeted faulty
variant. The runtime enforces check/attempt independence; it must not reject
same-assertion evidence merely because the identity is shared.

## Decision

### Deterministic pre-admission is limited to structural contradictions

The claim contract validates:

- a declared `expectedAssertion` is reachable from the positive check's active
  verification candidate and its provider/format/codec identity;
- positive and counterexample checks are distinct and resolve to distinct
  executions;
- a `specific_behavior` claim carries at least one claim-specific binding
  (`expectedAssertion`, assertion counterexample, structural surface, or mutation
  profile).

The contract does not parse prose, infer claim breadth, or simulate a faulty
variant. Semantic sufficiency remains reviewer-owned.

### The reviewer remains strict and unchanged

The reviewer continues to reject over-broad claims, second green runs presented
as counterexamples, and variants bound to the wrong observable. No reviewer
prompt change is part of this decision.

### A late revision is never adopted silently

When the final review verdict exhausts the iteration budget and carries a plan
revision, only the independently reviewed plan remains current and approvable.
The discarded revision is reported with `adopted: false`, its version and the
current plan version. The plan author must not present it as current.

### Exhausted gates require an explicit user decision

The user can:

- `/request-changes` — start a new review cycle and resubmit the revision for
  independent review;
- `/override-approve <Begründung>` — accept the reviewed artifact despite open
  findings, with a non-empty durable rationale;
- `/reject` — decline the reviewed artifact.

No command auto-adopts an unreviewed revision. A new cycle gets a fresh review
budget; the reviewer must accept the revision before it becomes current.

### The plan author must address every blocking finding

Plan guidance requires a revised plan to address every blocking finding from the
previous review, map each finding to the changed section or claim, and state what
changed. At the final iteration the author stops and hands the decision to the
user. This is authoring guidance, not enforcement; the reviewer remains the
semantic gate.

## Consequences

- Structurally unreachable positive assertions fail before a reviewer is spent.
- Same-assertion counterexample evidence remains valid and is explicitly
  protected against future over-strict checks.
- Semantic findings may still require multiple review iterations. The process no
  longer dead-ends at the exhausted gate and never silently adopts an unreviewed
  revision.
- The exhausted-gate copy uses the exact `/override-approve <Begründung>` form,
  so an empty override is not presented as a viable next step.
- No state schema change is introduced. The discarded revision remains in the
  conversation and audit; the user starts a new cycle and the author resubmits
  it.

## References

- [ProofGraph evidence and counterexamples](../proofgraph.md)
- [Independent review](../independent-review.md)
- [ADR-008: Reviewer authority boundaries](./008-reviewer-authority-boundaries.md)
- [Commands: /override-approve](../commands.md#override-approve)
