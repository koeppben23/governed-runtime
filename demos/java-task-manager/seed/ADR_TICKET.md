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

## Constraints

- Do not propose changes to the Repository interface
- Do not propose `Optional<T>` wrapper types
- Do not propose framework-level changes (AOP, interceptors)
- Focus on service-method-level responsibility only

## Acceptance Criteria

- ADR with all 3 MADR sections present and substantive
- Independent subagent review accepts the ADR
- Human approval at ARCH_REVIEW
- Exportable evidence at ARCH_COMPLETE
