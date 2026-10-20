# ADR-008: Reviewer Authority Boundaries

- **Status:** Accepted
- **Date:** 2026-10-19
- **Accepted:** 2026-10-20
- **Deciders:** FlowGuard maintainers

## Context

The independent reviewer is a semantic judge inside a deterministic governance
system. Recent plan-review runs exposed two different problems that must not be
collapsed:

1. **Termination:** a reviewer child can stop at the host output limit without a
   final answer, or be stopped by the host step budget.
2. **Evaluation:** a reviewer that finishes can still apply the professional
   standard inconsistently, for example by accepting a counterexample that only
   repeats a normal success case.

Generation `p42-v7` already states the counterexample-sufficiency rule in
`src/templates/mandates-reviewer-criteria.ts`. The open question is not the
wording; it is whether the reviewer applies the rule correctly to concrete
evidence. Adding more prompt rules to force convergence would blur the
responsibility boundary and is not adopted.

## Options

### Option A: Keep the current boundaries and measure the reviewer

- Deterministic core owns mechanically decidable facts.
- The reviewer owns semantic judgment.
- The governance gate owns acceptance of complete, correctly bound decisions.
- A fixed reference suite measures termination and evaluation separately.

**Pros:** Preserves fail-closed authority, makes reviewer quality observable,
and avoids prompt-rule proliferation.

**Cons:** Counterexample sufficiency remains a semantic reviewer judgment until
a future formal mechanism is justified by evidence.

### Option B: Move semantic judgment into the deterministic core

- Encode counterexample sufficiency, claim-evidence fit, and risk judgment as
  schema checks.

**Pros:** Stronger determinism.

**Cons:** Rejected. The core cannot decide every semantic question from the
evidence it has, and pretending otherwise would hide unverified assumptions in
formal checks.

### Option C: Strengthen the prompt until the reviewer converges

- Add more rules and examples to the reviewer task contract.

**Pros:** Low implementation cost.

**Cons:** Rejected. It conflates termination with evaluation quality, is hard to
measure, and risks suppressing legitimate findings.

## Decision

Keep the existing authority boundaries:

- **Deterministic ProofGraph core:** digests, evidence identities,
  execution results, attempt and check bindings, candidate identity, formal
  evidence requirements, and plan/approval certificates. It never authors
  semantic verdicts.
- **Independent reviewer:** semantic review, falsification, counterexample
  sufficiency, completeness, actual risk, and claim-evidence fit. It never
  authors digests, bindings, execution identity, or attestation authority.
- **Deterministic governance gate:** accepts only complete, correctly bound
  decisions and fails closed otherwise.

The reviewer reference suite (`demos/reviewer-reference-suite/`) separates
`plan_review` and `implementation_review` gold standards. Plan review does not
require future execution results; formal ProofGraph claim states are not
reviewer verdicts. The token-limit experiment changes only the OpenCode output
cap and must not change the model, variant, criteria, prompt, frozen subject, or
governance gates.

A structured falsification descriptor (for example, a declared faulty variant
with an expected failure) is **not** adopted by this ADR. It would be a separate
decision requiring reference-suite evidence that the semantic reviewer cannot
apply the rule reliably.

The operational output-token baseline is **65K**, set on the OpenCode host with
`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536`; 32K remains the fallback. This is
a host-process setting, not a prompt, criteria, or governance change. It is a
**conditional baseline**: the reference suite shows 65K full-loop B 3/3 and
targeted full-loop R 3/3, but the combined 65K full-loop R evidence is 3/4
because one run retained the R-B counterexample interpretation. The residual
semantic risk is monitored, not declared closed.

## Consequences

- A reviewer that changes from `finish: "length"` to `finish: "stop"` is not
  automatically more reliable. Termination and evaluation remain separate
  measurements.
- A higher output cap is a conditional baseline, not a full validation. The 65K
  baseline is supported by the reference suite, but the residual R-B false
  positive means reviewer reliability is not statistically guaranteed. 32K
  remains the fallback.
- New reviewer prompt rules or formal falsification schema fields require
  reference-suite evidence and a new decision; they are not accepted as ad-hoc
  hardening.
- The suite's deterministic tests prove fixture consistency only. The
  independently authored gold standard remains the semantic reference.
