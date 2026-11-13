# ADR-012: Executed source variants for falsification evidence

- **Status:** Implemented as a corrective evidence-contract change; independent
  reviewer reference-suite evidence for the new semantic obligation remains
  **NOT_VERIFIED**
- **Date:** 2026-11-13
- **Deciders:** FlowGuard operator
- **Supersedes:** the ADR-008 paragraph stating that a structured falsification
  descriptor is not adopted
- **Related:** [ADR-008](./008-reviewer-authority-boundaries.md),
  [ADR-010](./010-host-neutral-opt-in-governance.md), PR #1223
- **Scope:** ProofGraph counterexample evidence, plan claim admission, positive
  assertion admission, and native `/start` profile presentation

## Context

A governed run (`ses_e2bd81786ffe0EIPK2a0bwiuPt`, installed `10810b93`) ended
`COMPLETE` with three `PROVEN` claims. The plan promised a targeted
falsification: remove a null guard, keep the regression test, observe the
failure, restore the guard. The host history contains no such execution. Two
post-implementation runs were green against the same repaired digest.

FlowGuard nevertheless bound the green `build` attempt as:

```
scenario: "falsification via check 'build'"
outcome: "supported"
```

`counterexample-binder.ts` classified a matching passing assertion as
`supported`, and `evaluate.ts` accepted a fresh `supported` counterexample as
satisfied adversarial evidence. A second green standard run was therefore an
adversarial proof. The independent reviewer accepted the counterexample
hypothetically ("would fail") without an executed variant.

Independently, plan admission rejected two non-critical claims that declared a
concrete `expectedAssertion` but no `counterexampleRequirement`. The public plan
schema preserved `expectedAssertion`, so schema, admission, binder and evaluator
disagreed about the same declaration.

ADR-008 deferred a structured falsification descriptor and required a separate
decision plus reference-suite evidence for formal schema fields. The false
`PROVEN` result is a correctness defect, not new reviewer hardening, so this
ADR records the narrowly scoped repair and its limits.

## Options

1. **Keep the ordinary green run as `supported`.** Rejected. It conflates
   positive execution with adversarial evidence and can produce `PROVEN` for an
   unexecuted promise.
2. **Require a failing ordinary run.** Rejected. It can only contradict a claim;
   it cannot demonstrate that the bound check detects a targeted violation while
   the correct implementation passes.
3. **Execute an approved exact source variant in isolated source copies.**
   Selected. The plan must declare `path`, `before`, and `after`; the runtime
   executes the approved candidate against a control copy and a mutated copy.
   Only a passing control plus a detected variant failure is `supported`.
4. **Introduce a language-aware mutation/fault-injection framework.** Out of
   scope. It would add a provider with its own execution authority and is not
   required to stop the observed false proof.

## Decision

- `CounterexampleRequirement` carries an optional `variant`:
  `{ path, before, after }`. `before` must occur exactly once; `after` is a
  literal replacement and may be empty. The path must be canonical and
  repository-relative.
- Plan admission requires a variant on every declared counterexample. Manual
  `/declare-contract` declarations cannot authorize source perturbations; their
  adversarial obligation remains unresolved and advisory.
- `expectedAssertion` is part of `NormalizedClaimDeclaration`, validated against
  a capable positive candidate, accepted as a claim-specific binding, and used
  by evaluator claim-carrying checks. Schema, admission, binder and evaluator
  share one provider-capability helper.
- Before review material is frozen, the runtime copies the Git-enumerated
  current sources (tracked and non-ignored untracked files) into private control
  and variant directories. It executes the existing candidate in both, attests
  the original and copied source digests around the control and variant runs,
  and records an immutable
  `FalsificationExecution` on the implementation `ValidationAttempt` with claim
  and declaration binding, execution identities, source digests, commands, exit
  codes, output digests and extracted assertions.
- A green ordinary attempt yields `not_verified` for the adversarial obligation,
  never `supported`. A detected variant failure yields `supported` only when the
  control passed at the same declared assertion and the current approved plan
  certificate still binds the exact declaration.
- Unavailable execution (missing ignored dependencies or build outputs, a
  non-unique `before`, source drift, an invalid certificate, a test-source
  target or a verification execution input) records **no** adversarial support.
  The ordinary check is still recorded and the claim stays `NOT_VERIFIED`; it
  does not wedge the validation phase.
- The copied directories are source isolation, not a process sandbox. The
  approved command retains its OS privileges and may reach external
  dependencies or caches. Ignored dependencies and build outputs are not copied
  or installed automatically.
- Plan presentation renders the exact variant path and before/after bytes for
  human and reviewer approval. Review evidence includes the falsification
  records. Their frozen digest therefore covers the executed variant evidence.
- Native `/start` stops forcing `profileId: 'baseline'` and uses the canonical
  profile precedence. The existing status card states the actual selection
  source; the host prompt explicitly requires the complete card rather than a
  model summary.

## Consequences

- Existing persisted plans with a counterexample but no variant now evaluate
  `NOT_VERIFIED` instead of `PROVEN`. This is the intended tightening. In-flight
  sessions that need a different approved variant follow the existing
  new-session recovery; no persisted claim is deleted or downgraded in place.
- Each declared variant adds two real candidate executions and their assertion
  extractions to session state. The cost is proportional to the number of
  distinct declared variants, not to ordinary checks.
- Source isolation preserves exact bytes, executable bits and the Git file set,
  but deliberately cannot reproduce ignored dependencies or build outputs.
  Commands that require them report no adversarial support.
- The runtime binds execution and detects the declared assertion. It does not
  decide whether the perturbation is semantically relevant. The independent
  reviewer must inspect that, and the plan reviewer sees the exact bytes before
  approval.
- No reference-suite evidence establishes that reviewers apply the new
  semantic obligation reliably. Reviewer reliability under this rule remains
  **NOT_VERIFIED** and requires the ADR-008 reference-suite work before it can be
  claimed.
- The host/model presentation of the `/start` card is instruction-bound, not
  mechanically guaranteed. Visual delivery remains host-dependent and is
  **NOT_VERIFIED** until a live host run confirms it.
