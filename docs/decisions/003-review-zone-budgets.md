# ADR-003: Review Zone File Budgets

- **Status:** Proposed
- **Date:** 2026-09-25
- **Deciders:** FlowGuard maintainers

## Context

Every review zone carries a `maxProductionFiles` budget in
`src/architecture/__tests__/integration-placement-policy.ts`. At the time of
this record all nine review zones sit exactly at their budget:

| Zone                  | Budget |
| --------------------- | -----: |
| `review`              |      6 |
| `review/dispatch`     |     11 |
| `review/obligations`  |     11 |
| `review/context`      |      8 |
| `review/observations` |      8 |
| `review/evidence`     |      9 |
| `review/validation`   |      4 |
| `review/prompting`    |      5 |
| `review/enforcement`  |     10 |

Adding a review file therefore always fails `zone-production-budget-exceeded`
until `maxProductionFiles` is raised in the same change or the zone is
decomposed. The budget is an intentional forcing function, not an observation:
it exists so that every new review file is an explicit architecture decision.

## Options

### Option A: Keep the hard budgets (status quo)

- **Pros:** Maximum pressure to decompose rather than grow; every change is
  visible in the authority diff.
- **Cons:** All zones are exhausted, so even justified additions require a
  budget edit; repeated rubber-stamp edits would weaken the signal.

### Option B: Add a small headroom reserve

- Give each zone a reserve (for example one or two files) above the current
  count.
- **Pros:** Removes immediate friction for a genuinely additive file.
- **Cons:** Silently converts a conscious decision into available headroom; the
  reserve will fill without an architecture discussion.

### Option C: Derive budgets from the observed file count

- Compute `maxProductionFiles` from the current tree.
- **Pros:** No manual maintenance.
- **Cons:** Rejected in principle: a budget derived from observation cannot
  detect growth. The budget must be independent of the current directory to
  have any effect.

### Option D: Per-change exception process

- Keep budgets and allow a documented exception per change.
- **Pros:** Preserves the signal and still allows justified growth.
- **Cons:** Adds process weight for a decision the diff already makes visible.

## Decision

**Defer.** Keep the hard budgets (Option A) while decomposition remains the
better answer for review-zone growth. The placement authority already treats
raising a budget as a deliberate architecture decision, and the guard reports
the concrete fix. Revisit this ADR when a concrete change is blocked and
decomposition is not sensible; then prefer Option D over a blanket reserve.

## Consequences

- Every review file addition or move requires a conscious budget decision in
  the same change.
- The friction is intentional and documented in the Add/Move/Delete checklist
  in `docs/development/architecture-map.md`.
- No implementation change follows from this record.
