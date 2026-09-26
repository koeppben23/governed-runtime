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

The facade is **not** a published consumer surface: `package.json#exports`
contains no entry for `dist/integration/review/index.js`, and
`src/integration/index.ts` does not re-export it. There is no supported way for
a package consumer to import it; out-of-band source imports are not a contract
this repository maintains.

The dependency-rules test additionally asserts that the barrel exists and
exposes `updateObligation`, `blockObligation`, and `appendReviewAuditEvent`.
Removing the file would therefore require coordinated changes in the placement
authority, the review zone policy, `dependency-rules.test.ts`, the
unused-exports baseline, and documentation, preceded by an importer/export
audit.

## Options

### Option A: Keep the facade as the public composition surface (status quo)

- **Pros:** A stable composition surface for the bounded context; the
  zero-importer rule keeps internals honest; removal is not required for
  correctness.
- **Cons:** One more file whose purpose is contractual rather than functional.

### Option B: Remove the facade and rely on concrete subzone imports

- **Pros:** Removes an indirection with no current production consumer.
- **Cons:** Changes the bounded-context surface; requires an importer and
  export audit (package exports, generated `dist/` surface, unused-exports
  baseline) before removal.

### Option C: Keep the facade but trim it to the documented API

- **Pros:** Preserves the surface and reduces accidental exports.
- **Cons:** Still a contract change; only worth doing together with a real
  consumer or consolidation need.

## Decision

**Defer.** Keep Option A for now. The zero-importer state is the enforced
in-repo contract, but it is not evidence of an external consumer: the facade is
not reachable through the package exports. Revisit only after an importer and
export audit proves the surface obsolete — not because of hypothetical
out-of-band source imports — and then prefer Option B over an ad-hoc trim.

## Consequences

- The facade remains the frozen composition surface of the review bounded
  context; production code under `src/` must keep importing concrete subzone
  authorities. It is not part of the published package exports.
- No implementation change follows from this record.
