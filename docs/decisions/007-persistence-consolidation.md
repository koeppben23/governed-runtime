# ADR-007: Persistence Module Consolidation

- **Status:** Proposed
- **Date:** 2026-09-25
- **Deciders:** FlowGuard maintainers

## Context

Persistence is split across seven production modules under `src/adapters/`:
`persistence.ts`, `persistence-core.ts`, `persistence-config.ts`,
`persistence-audit.ts`, `persistence-discovery.ts`, `persistence-lock.ts`, and
`persistence-observation-ledger.ts`. They do not share one contract:

- `persistence.ts` owns state reads/writes and the persistence-boundary
  implementation-entry guard.
- `persistence-lock.ts` owns the non-reentrant session write lock.
- `persistence-audit.ts` and `persistence-observation-ledger.ts` serve audit
  and observation ledgers.
- `persistence-discovery.ts` serves the advisory discovery artifact.
- `persistence-core.ts` owns typed error codes and shared primitives.

The direct-write channel was hardened separately (PR #945): the channel
inventory and its allowed mutations are documented in
`docs/development/state-changing-operation.md` §3.1, and a fail-closed guard
rejects protected authority changes. Function count alone is not evidence that
consolidation would improve anything, and the recent stabilization is a reason
for caution.

## Options

### Option A: Keep the modules as separate channels (status quo)

- **Pros:** Each contract (state, lock, audit ledger, observation ledger,
  discovery, errors) stays explicit; the hardened boundaries remain untouched.
- **Cons:** Seven entry points require discipline and documentation.

### Option B: Consolidate behind a single facade

- Keep the module split internally, expose one import surface.
- **Pros:** Fewer import paths for callers.
- **Cons:** Cosmetic; changes no contract and adds an indirection.

### Option C: Merge modules

- Merge related modules (for example core into state persistence).
- **Pros:** Fewer files.
- **Cons:** Mixes atomicity and audit contracts; risks the locking ordering and
  ProofGraph-consistency guarantees established by the hardened writer path.

## Decision

**Defer.** Consolidation is not pursued without a proven defect. Preconditions
for revisiting:

1. a complete writer inventory (already documented in
   `state-changing-operation.md` §3.1),
2. measurable performance baselines from `PERF_BUDGETS`,
3. regression tests for audit atomicity, lock ordering, and ProofGraph
   consistency across the affected channels.

Function count alone does not justify a merge.

## Consequences

- The stabilized persistence boundaries stay as they are.
- Any future consolidation must first produce the evidence above; otherwise
  this ADR remains Proposed and the topic closed.
