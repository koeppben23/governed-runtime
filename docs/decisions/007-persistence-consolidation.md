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

The direct-write channel was hardened separately (PR #945) and now fails closed
without an existing state: the channel inventory and its allowed mutations are
documented in `docs/development/state-changing-operation.md` §3.1, and the
fail-closed guard rejects protected authority changes as well as absent state.
Function count alone is not evidence that consolidation would improve anything,
and the recent stabilization is a reason for caution.

The original forensic finding this record responds to was not the module count:
it counted nine writer entry points, one parallel write path that bypassed
`prepareState`, and repeated `SessionState.safeParse` calls on the write path
(claimed five per write). The parallel path is closed: the direct channel is
allowlisted and rejects missing state, and the gate writers re-read and
re-apply under the session lock.

The validation count is now traced (R5 evidence, pinned by
`src/integration/governed-write-path-evidence.test.ts`) instead of estimated:

- full-prepare update of an existing session: **6** `SessionState.safeParse`
  executions — the read boundary, the prepare input, the ProofGraph-refreshed
  output, the audit-operation preparation, the prepared-artifact commit, and
  the raw persistence boundary;
- direct metadata write: **3** (read, audit preparation, raw write boundary);
- `mutateStateWithAuditOperations` and `updateReviewAssurance`: **4** each,
  because both read the state and then re-read it under the session lock (the
  direct-write guard and the mutation need the post-lock authority).

Each call is a fail-closed boundary with a distinct guard role: the raw
`writeStateAlreadyLocked` check never lets invalid state reach disk,
`prepareAuditOperations` is a public entry that can be called with unprepared
state (regulated completion), `prepareState` validates both input and the
refreshed projection, and the commit helper validates the prepared payload
before I/O. The duplicated reads are the cost of applying a decision to the
state read under the lock.

The full-prepare writer additionally reconciles a stale caller snapshot with
the current authority: it carries forward every audit operation of the
persisted state that the prepared state does not contain (persisted status
wins on id collision, missing operations are appended in order, and the newly
prepared operation stays latest). This closes a latent evidence-loss path —
several tool flows prepare their next state from an entry snapshot and would
otherwise replace an operation committed in between. The regression test
drives an intervening write and proves the committed operation survives into
the persisted state.

Measured on 2026-09-26 with `PERF_BUDGETS.stateGovernedWriteMs` (200 measured
iterations after warm-up) on a state-changing workload: the fixture carries a
structural proof contract (`refreshProofGraph()` evaluates the claim, no
fast-path return), a reset hook restores the same canonical session before
every sample (constant audit backlog), and every call changes the `error`
authority and creates exactly one new `state_write` operation. Evidence: p99
17.3-34.5 ms across four runs, p95 17.27 ms, median 14.32 ms against the
200 ms local budget (>5x headroom against the worst observed spike, ~14x the
median). **Measured boundary:** the fixture uses a structural-surface claim;
provider-bound mutation-result verification is not part of this measurement.
**Disposition: no consolidation**. The count is a consequence of layered
fail-closed boundaries, not a defect, and the measured path stays inside
budget.

## Options

### Option A: Keep the modules as separate channels (status quo)

- **Pros:** Each contract (state, lock, audit ledger, observation ledger,
  discovery, errors) stays explicit; the hardened boundaries remain untouched.
- **Cons:** Seven modules with multiple writer entry points (nine counted by
  the original review) require discipline and documentation.

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

1. a complete writer inventory by **entry point** (the channel inventory is
   documented in `state-changing-operation.md` §3.1),
2. measured baselines for the affected channels (the governed full-prepare
   write is gated by `stateGovernedWriteMs`; further channels need their own),
3. regression tests for audit atomicity, lock ordering, and ProofGraph
   consistency across the affected channels.

Function count alone does not justify a merge. Reducing the entry-point count is
a candidate for a later, evidence-backed change only after (1) and (2) exist; it
is not a consolidation mandate.

## Consequences

- The stabilized persistence boundaries stay as they are.
- Any future consolidation must first produce the evidence above; otherwise
  this ADR remains Proposed and the topic closed.
