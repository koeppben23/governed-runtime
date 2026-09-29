# Architecture Task — Service-Layer Null-Safety Standard

## Task Context

- 3-Tier architecture: Controller → Service → Repository
- `TaskRepository.findById()` returns null for missing IDs
- `TaskService.getTask()` null-checks → TaskNotFoundException (404)
- `TaskService.updateTask()` does NOT null-check → NullPointerException (500)
- This inconsistency is the root cause of the bug documented in TICKET.md

## Requested Output

Create a MADR-format Architecture Decision Record (ADR).

The generated ADR must contain these MADR sections:

- `## Context`
- `## Decision`
- `## Consequences`

## Decision Quality Requirements

- Read `TICKET.md` before drafting; its required regression-test changes are
  input to the ADR's verification path.
- Make the service-layer constraints and forces explicit.
- Compare at least two realistic service-layer options with their trade-offs.
- Explain why the selected option follows from the stated forces and evidence.
- State specific positive and negative consequences, including compatibility
  impact on schemas, state, persistence, and public contracts.
- Define a falsifiable validation path that includes the controller regression
  test and missing-ID behavior required by `TICKET.md`.

## Constraints

- Do not propose changes to the Repository interface
- Do not propose `Optional<T>` wrapper types
- Do not propose framework-level changes (AOP, interceptors)
- Focus on service-method-level responsibility only

## Acceptance Criteria

- ADR with all 3 MADR sections present and substantive
- ADR explicitly covers the decision quality requirements above
- Independent subagent review accepts the ADR before human approval at ARCH_REVIEW
- Terminal `ARCH_COMPLETE`; retain and verify a raw `/archive` package when
  evidence must be collected outside the live session
