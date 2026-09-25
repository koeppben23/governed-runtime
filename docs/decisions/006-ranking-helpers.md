# ADR-006: Ranking Helper Consolidation

- **Status:** Proposed
- **Date:** 2026-09-25
- **Deciders:** FlowGuard maintainers

## Context

Implementation guidance ranks candidate items before presentation:
`rankItems` (`src/integration/implementation-guidance.ts`) deduplicates by
identity, caps confidence against Discovery health, and sorts by
`confidenceRank`. The forensic review suspected an old duplicate ranking
structure that could be reduced.

The suspicion is not yet backed by an inventory: a repository-wide search finds
a single `rankItems` implementation and no second ranking authority. Any
consolidation therefore risks changing presentation order — a behavior change
without a proven defect.

## Options

### Option A: Keep the helpers as they are (status quo)

- **Pros:** No behavior risk; the current ordering contract stays untouched.
- **Cons:** If a real duplicate exists elsewhere, it stays unfactored.

### Option B: Behavior-neutral consolidation with regression tests

- First inventory every ranking/deduplication helper and its observable order.
- Then consolidate only when the same ordering contract is proven duplicated,
  with golden-order tests pinning the result.
- **Pros:** Removes real duplication without changing output.
- **Cons:** Requires the inventory and tests before any benefit.

### Option C: Consolidate now

- Merge helpers immediately, optionally with an options flag.
- **Pros:** Fast.
- **Cons:** Rejected: risks order changes, and new boolean options are exactly
  the pattern this repository avoids.

## Decision

**Defer.** Require the inventory from Option B before any consolidation. If the
inventory shows no genuine duplicate, close the topic as a non-finding.

## Consequences

- Guidance ordering remains stable in the meantime.
- A follow-up change, if any, must include golden-order tests and no new
  boolean options.
