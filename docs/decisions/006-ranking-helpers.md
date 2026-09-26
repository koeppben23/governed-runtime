# ADR-006: Ranking Helper Consolidation

- **Status:** Proposed
- **Date:** 2026-09-25
- **Deciders:** FlowGuard maintainers

## Context

Implementation guidance ranks candidate items before presentation:
`rankItems` (`src/integration/implementation-guidance.ts`) deduplicates by
identity, caps confidence against Discovery health, sorts by `confidenceRank`,
and truncates to the section limit. `buildRankedSection` composes it with
`onlyCorroborated`, controlled by `corroboratedOnly?: boolean` (four production
call sites: relevant files, modules, surfaces, contracts).

A repository-wide search finds a single `rankItems` implementation and no second
ranking authority. The forensic finding is not a duplicate ranking structure:
it is the options object around that single implementation and the order in
which corroboration filtering and truncation were applied. That order was
reproduced: because `rankItems` truncated before `onlyCorroborated` ran,
uncorroborated discovery-only items could consume the limit and a corroborated
session-owned changed file with room left was dropped. The fix filters
corroborated candidates before the limit; consolidation of the helpers
themselves is still not established.

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
- **Cons:** Rejected: risks order changes without an inventory, and does not
  address the actual finding (the existing `corroboratedOnly` flag and the
  filter/limit order). Newly introduced boolean options remain a pattern this
  repository avoids.

## Decision

**Defer** for consolidation. The reproduced ordering defect was fixed by
filtering corroborated candidates before the limit (behavior tests, including
the renamed characterization case, pin the result). Any further consolidation
still requires the inventory from Option B; if it shows no genuine duplicate,
close the consolidation topic as a non-finding.

## Consequences

- Corroboration now selects before truncation, so corroborated session evidence
  is not displaced by uncorroborated discovery items.
- A follow-up consolidation, if any, must include golden-order tests and no
  newly introduced boolean options.
