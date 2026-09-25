# ADR-005: Review Facade Retention and Removal

- **Status:** Proposed
- **Date:** 2026-09-25
- **Deciders:** FlowGuard maintainers

## Context

`src/integration/review/index.ts` is declared the public bounded-context facade
for the review pipeline. The zone policy requires that production code
**never** imports it; internal callers import the concrete subzone authority
(`review-zone-policy.ts`, rule `production-facade-import`). At the time of this
record the facade has **zero production importers** — that is the enforced
contract, not dead code.

The dependency-rules test additionally asserts that the barrel exists and
exposes `updateObligation`, `blockObligation`, and `appendReviewAuditEvent`.
Removing the file would therefore require coordinated changes in the placement
authority, the review zone policy, `dependency-rules.test.ts`, and
documentation.

## Options

### Option A: Keep the facade as the public composition surface (status quo)

- **Pros:** A single stable surface for external consumers; the zero-importer
  rule keeps internals honest; removal is not required for correctness.
- **Cons:** One more file whose purpose is contractual rather than functional.

### Option B: Remove the facade and rely on concrete subzone imports

- **Pros:** Removes an indirection with no current production consumer.
- **Cons:** Changes the public surface of the bounded context; requires an
  importer and contract audit (including downstream consumers outside this
  repository and the unused-exports baseline) before removal.

### Option C: Keep the facade but trim it to the documented API

- **Pros:** Preserves the surface and reduces accidental exports.
- **Cons:** Still a contract change; only worth doing together with a real
  consumer or consolidation need.

## Decision

**Defer.** Keep Option A. Removing a documented public facade purely because it
has no current in-repo importer would confuse "unused inside the monolith" with
"without a contract". Revisit only after an importer/contract audit proves the
surface is obsolete; then prefer Option B over an ad-hoc trim.

## Consequences

- The facade remains the single external composition surface; production code
  under `src/` must keep importing concrete subzone authorities.
- No implementation change follows from this record.
