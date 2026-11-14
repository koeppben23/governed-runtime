# ADR-014: Plan evidence preflight and structural finding closure

- **Status:** Accepted
- **Date:** 2026-11-14
- **Context:** Repeated plan-review iterations were caused by incomplete author
  evidence design and by revisions that silently ignored prior findings or
  removed critical claims. The independent reviewer was correct; the inputs and
  closure loop were incomplete.
- **Related:** ADR-008 reviewer authority boundaries; ADR-013 evidence
  pre-admission.

## Context

FlowGuard keeps three authorities separate:

1. the deterministic plan preflight, which checks declaration completeness;
2. the independent reviewer, which judges semantic sufficiency;
3. executed, revision-bound evidence, which alone can prove behavior.

A structural validator cannot decide whether a described faulty variant truly
falsifies a claim. A filled JSON field is not executed evidence, and an author
response is not a reviewer confirmation.

## Decision

### Evidence Design is a structural plan-text contract

Every critical claim declares a `flowguard-evidence-design` entry with the exact
authority section and statement, the positive observable, a concrete faulty
variant, the expected failure, and an execution route naming the active
counterexample candidate. The preflight rejects missing, duplicate, malformed,
placeholder, or inactive-candidate declarations. It does not judge semantic
sufficiency.

### Finding responses and claim lineage are separate contracts

A revision on an open review answers every bound blocking finding in a
`flowguard-finding-resolutions` block bound to the exact review obligation,
iteration, plan version, and host-minted finding identity. A response may be a
reasoned clarification; no cosmetic edit is forced, and no response is treated
as confirmed resolution.

Any removal or replacement of a prior critical claim is declared in a
`flowguard-claim-changes` block. A same-identity critical downgrade is forbidden.
A replacement must resolve to one or more accepted critical claims; a withdrawal
requires a rationale. The deterministic gate verifies coverage and identity, not
whether the replacement preserves the ticket requirement.

### Identity and feedback authority

Finding identities are minted once at the authoritative capture boundary and
persisted with the findings. Capture comparison ignores only those host-minted
identities; reviewer-owned message, severity, category, and relation changes
remain binding failures. The author reads finding IDs and prior critical claim
IDs through existing read-only status projections. Admission validates against
canonical persisted evidence, never against copied feedback.

### No session schema change

The new contracts live in the frozen plan text. `SessionState` remains v11.
Existing completed sessions stay readable. A current plan that predates the
contract must add the declarations on its next revision; old open review
findings without host identities fail closed with an explicit recovery.

## Consequences

- Plans declare their evidence design before an independent reviewer is spent.
- Revisions cannot silently ignore bound blocking findings or downgrade critical
  scope; they can still disagree with a finding through a reasoned response.
- Semantic closure, requirement preservation, and falsification remain
  `NOT_VERIFIED` until the independent reviewer and executed evidence establish
  them.
- Fewer iterations and improved reviewer recall are not claimed without the
  separate defect-corpus measurement.
