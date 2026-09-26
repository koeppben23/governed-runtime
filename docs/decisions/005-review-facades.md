# ADR-005: Review Facade Retention and Removal

- **Status:** Accepted
- **Date:** 2026-09-26
- **Deciders:** FlowGuard maintainers

## Context

`src/integration/review/index.ts` was declared the public bounded-context facade
for the review pipeline. The zone policy required that production code
**never** import it; internal callers import the concrete subzone authority
(`review-zone-policy.ts`, rule `production-facade-import`). Until this decision
the facade had **zero production importers** — an enforced contract that also
required the file to exist.

The facade was **not** a published consumer surface: `package.json#exports`
contains no entry for `dist/integration/review/index.js`, and
`src/integration/index.ts` does not re-export it. There was no supported way for
a package consumer to import it, and out-of-band source imports are not a
contract this repository maintains.

The 2026-09-26 importer and export audit required by the earlier deferral found:

- zero production importers and zero test importers;
- no package-export reachability (the symbol surface is absent from the
  generated `dist/` entry declarations);
- `updateObligation`, `blockObligation`, and `appendReviewAuditEvent` are
  already consumed at their concrete subzone authorities
  (`review/obligations/obligation-state.ts`,
  `review/evidence/audit-events.ts`);
- the file was kept alive only by its placement entry, the zone-policy facade
  rule, and the existence assertion in `dependency-rules.test.ts`.

## Options

### Option A: Keep the facade as an enforced contract (previous deferral)

- **Pros:** A stable composition surface on paper.
- **Cons:** A contract-only file with no consumer; the guard forbade its use and
  required its existence at the same time, so it could never earn a consumer.

### Option B: Remove the facade and rely on concrete subzone imports (chosen)

- **Pros:** Removes an indirection with no consumer; the bounded context has one
  import style (concrete authorities); the zone policy keeps the acyclic graph
  and its budgets.
- **Cons:** Reintroduction needs a deliberate new decision; hypothetical
  out-of-band source-import consumers (never a supported surface) would break.

### Option C: Keep the facade but trim it to the documented API

- **Cons:** Still a contract change with no consumer; rejected for the same
  reason as Option A.

## Decision

**Remove `src/integration/review/index.ts` (Option B).** Delete the placement
entry, the facade constant and the `production-facade-import` rule in
`review-zone-policy.ts`, and the two barrel assertions in
`dependency-rules.test.ts`; replace the latter with a negative guard that fails
if the barrel reappears. Update the integration contributor notes and the
architecture map.

## Consequences

- The review bounded context has no barrel; production code and tests import the
  concrete subzone authorities.
- `dependency-rules.test.ts` fails if `integration/review/index.ts` is
  reintroduced without a new decision record.
- The declared review zone graph and the zone budgets are otherwise unchanged;
  the `review` root zone keeps only cross-zone primitives.
