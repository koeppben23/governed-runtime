# ADR-004: Frozen Root Matrix

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** FlowGuard maintainers

## Context

The integration root zone (`src/integration/*.ts`) is the composition and
host/runtime boundary. `integration-placement.test.ts` freezes its exact shape
(counts updated 2026-11-03):

- `root-composition`: 33 files (plugin lifecycle entrypoints and barrels)
- `root-host-runtime`: exactly 7 named files (`host-mutation-observation.ts`,
  `installed-commands.ts`, `opencode-governance-rpc.ts`, `opencode-governance.ts`, `opencode-host-adapter.ts`, `runtime-instance.ts`, `runtime-lease.ts`)
- `root-authority`: 15 files (cross-context authorities such as
  `audit-outbox.ts` and `tool-names.ts`)
- total: 55 root production files

The activation/scope change in #1190 adds `plugin-native-tools.ts` for native
catalogue/executor/completion composition and `opencode-governance.ts` for exact
host session/delegation correlation. Durable activation schemas and lifecycle
validation remain in `state/` and `machine/`; the journal is owned by `adapters/`.
Neither new root file supplies a competing workflow or approval authority.

Finding 6 step 2 adds `plugin-native-review.ts` to connect native hooks to the
existing dispatch ledger and frozen prompt owners. `plugin-native-events.ts`
holds the extracted event consumer/fence so `plugin.ts` retains single hook
registration ownership within its unchanged 650-LOC budget. These composition
files add no evidence, approval, capture or recovery authority. The named
`review/dispatch/native-review-dispatch.ts` growth exception isolates native V2
pre-release/current-child checks without invoking obsolete host DTOs; the zone's
growth target and all file-size limits remain unchanged.

ADR-009 added `plugin-reviewer-capture.ts` as hook composition and
`reviewer-capture.ts` as the synchronous request-provenance/capture-fence authority.
The #1169 lifecycle simplification removes the hook-wrapper module: `plugin.ts`
owns single native V2 registrations. The V1 Task capture fence
(`reviewer-capture.ts`), its execution watchdog and failure persister
(`reviewer-execution-watchdog.ts`, `reviewer-execution-failure.ts`) and the
`chat.params` output-cap persister (`reviewer-output-cap-failure.ts`) were
removed with the V1 reviewer transport (2026-11-02); they had no V2 production
caller. The current same-child capture fence is
`review/dispatch/native-review-capture.ts`. No replacement root module or new
authority was added.

`integration/reviewer-output-cap.ts` and the `reviewer.outputTokenMax` key were
removed (2026-11-02): FlowGuard applies no reviewer output cap, model options stay
host-native, and an unreadable or invalid `flowguard.json` now blocks ACTIVE
runtime creation in `plugin.ts` instead of only the reviewer context.

WS3 (#1190) adds `plugin-start-command.ts` at the composition boundary: it registers
the native `/start` command and sequences locked preflight/fresh hydration, the
activation commit, idempotent audit and best-effort catalogue/report publication.
ACTIVE/ACTIVATING reuse their verified workflow; no hydrate is used as a status
query, and governed runtime admission is gated until its durable audit confirmation exists.
The Start decision itself (channel, actor, lock, journal)
remains owned by `opencode-governance.ts` and `adapters/governance-activation.ts`;
the command module adds no activation, approval or workflow authority.

WS3 autonomous activation adds `opencode-governance-rpc.ts` as the public native
transport contract. Its dedicated `StartGovernance` operation shares the Start
composition and existing lifecycle, actor/policy, audit and admission authorities;
it introduces no alternate workflow or decision machine.

WS3 decision commands add `plugin-decision-command.ts` as native composition.
`workflow-decision-invocation.ts` replaces the unbound TTL intent authority with
scoped, exact-subject decision operations; no second workflow machine is added.
WS3 lifecycle commands add `plugin-governance-lifecycle-command.ts` and the pure
`governance-end-preconditions.ts`; they reuse the canonical review-settlement and
activation-journal authorities and add no parallel state machine.
WS3 `/check` and mandate injection add `plugin-check-command.ts` and
`plugin-mandates.ts`; both consume the existing command-scope and mandates
renderer authorities.

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
