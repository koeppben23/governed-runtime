# ADR-004: Frozen Root Matrix

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** FlowGuard maintainers

## Context

The integration root zone (`src/integration/*.ts`) is the composition and
host/runtime boundary. `integration-placement.test.ts` freezes its exact shape:

- `root-composition`: 23 files (plugin lifecycle entrypoints and barrels)
- `root-host-runtime`: exactly 4 named files (`installed-commands.ts`,
  `opencode-host-adapter.ts`, `runtime-instance.ts`, `runtime-lease.ts`)
- `root-authority`: 13 files (cross-context authorities such as
  `audit-outbox.ts` and `tool-names.ts`)
- total: 40 root production files

The guard-layer maintainability pass (PR #946) deliberately removed the
hardcoded total production-file count (221) and derived owner lists from the
placement authority, but kept these root counts explicit. The reason is that
the counts encode an architecture decision — which files may live at the root
at all — not an observation of the current directory.

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
