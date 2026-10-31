# ADR-004: Frozen Root Matrix

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** FlowGuard maintainers

## Context

The integration root zone (`src/integration/*.ts`) is the composition and
host/runtime boundary. `integration-placement.test.ts` freezes its exact shape
(counts updated 2026-10-31):

- `root-composition`: 28 files (plugin lifecycle entrypoints and barrels)
- `root-host-runtime`: exactly 5 named files (`host-mutation-observation.ts`,
  `installed-commands.ts`, `opencode-host-adapter.ts`, `runtime-instance.ts`, `runtime-lease.ts`)
- `root-authority`: 15 files (cross-context authorities such as
  `audit-outbox.ts` and `tool-names.ts`)
- total: 48 root production files

ADR-009 added `plugin-reviewer-capture.ts` as hook composition and
`reviewer-capture.ts` as the synchronous request-provenance/capture-fence authority.
The #1169 lifecycle simplification removes the hook-wrapper module: `plugin.ts`
owns single native V2 registrations. Unsupported reviewer execution is blocked
instead of registering a V1 capture/watchdog hook chain. Review modules still
consume the unchanged capture authority; they do not
import plugin composition. No replacement module or new authority was added.

`integration/reviewer-output-cap.ts` now validates native budgeting without
rewriting model options. The V1 `chat.params` hook is removed; the existing
`integration/reviewer-output-cap-failure.ts` terminal-persistence consumer uses
semantic session lookup, not SDK envelopes. These remain host integration,
not a new review authority. The bounded
execution watchdog and its terminal-persistence adapter live in
`integration/reviewer-execution-watchdog.ts` and
`integration/reviewer-execution-failure.ts`.

MUT4 (#1172) adds `plugin-mutation-reconciliation.ts` at the composition boundary
to connect asynchronous host notifications and the synchronous pre-implement
barrier to the existing completion writer. `host-mutation-observation.ts` owns
the pinned host-part parser at the host/runtime boundary. Episode lifecycle
authority remains in `state/evidence-mutation-episode.ts`.

The guard-layer maintainability pass (PR #945) deliberately removed the
hardcoded total production-file count (221) and derived owner lists from the
placement authority, but kept these root counts explicit. The reason is that
the counts encode an architecture decision — which files may live at the root
at all — not an observation of the current directory.

The counts were 23 + 4 + 13 = 40 at decision time; PR #963 added
`integration/risk-path-extraction.ts` at the root before the pins were
enforced, and PR #987 dropped the count pins from the placement suite. This
record's decision still governs, so the explicit count pins are reinstated in
`integration-placement.test.ts` and a documentation drift test keeps this
record aligned with the placement manifest.

## Options

### Option A: Keep the counts and the named file list explicit (chosen)

- **Pros:** Root growth or collapse requires a visible matrix change; the
  "only composition, host/runtime wiring, and authorities at the root" rule
  stays enforceable.
- **Cons:** Every legitimate root change touches the matrix test.

### Option B: Derive root membership from the placement authority

- Let the root zone accept any owner with `targetZone === 'root'`.
- **Pros:** Less duplication.
- **Cons:** Adding a new root owner would silently widen the allowed root
  surface; the matrix would no longer state a decision.

## Decision

**Keep Option A.** The explicit counts and the exact `root-host-runtime` file
list remain part of the frozen architecture contract. The owner lists around
them may be derived; the matrix itself must not be.

**Conditions to change:** a root change is allowed only as an explicit matrix
change in the same commit — updating the counts, the named list, the placement
entries, the placement guard, and any affected documentation. Silent growth
remains fail-closed.

## Consequences

- A new root file fails the matrix until the change states why the root surface
  should grow (or moves the file into a zone).
- The matrix remains readable as a deliberate architecture statement rather
  than a projection of the tree.
