# Machine Layer Contributor Notes

## Scope

This file adds instructions for files in this directory subtree.

## Authority

The state machine in `src/machine/` is the canonical authority for FlowGuard
phase transitions, guard evaluation, and command routing.

## State Transitions

- All phase transitions are defined in `topology.ts`. The topology is explicit:
  every transition is listed; there are no wildcard or catch-all transitions.
- `FLOW_PHASES` owns the canonical FORWARD progression per flow (used for
  evidence milestones) and `isFlowPhase(flow, phase)` owns flow membership.
  A progression is a semantic projection, NOT the full transition set:
  self-loops, backedges, `REJECTED`, `ABORTED`, and the `REDUCED_CEREMONY`
  shortcut are additional graph edges and must never be inferred from a
  progression.
- Flow selection from READY is derived from the graph
  (`resolveTransition('READY', event)`, wrapped by
  `rails/types.buildFlowSelectionTransition`). Consumers must not hardcode
  READY target phases, define local phase-rank maps, or copy a canonical
  progression (enforced by `architecture/__tests__/topology-authority-ssot.test.ts`).
- When adding a new phase, define every inbound and outbound transition
  explicitly.
- When removing a phase, verify no transition references the removed phase.

## Guard Ordering

- Guards are evaluated top-to-bottom in `guards.ts`. The first matching guard
  wins; later guards are never reached.
- The ERROR guard must always be checked first. Never insert a guard before
  ERROR that could shadow a blocked or failed state.
- Guards are pure functions — no side effects, no I/O, no state mutation.

## Evaluation

- `evaluate()` and `evaluateWithEvent()` are pure functions that produce a
  deterministic result from state plus event.
- The evaluator must remain policy-aware but never couple to a specific policy
  implementation.

## Testing

- State-machine invariants are tested in `state-machine-invariants.test.ts`.
- Fuzz tests in `state-machine.fuzz.test.ts` validate that random event
  sequences never produce invalid transitions.
- Unit tests for individual guards live in `guards.test.ts`.
- When changing transitions, run `npm run test:architecture` and the
  state-machine test suite.

## Commands

- The command surface is defined in `commands.ts`.
- New commands must be registered here and validated against the topology.

## Module Boundary

- `src/machine/` may import from `src/state/` and `src/shared/` only.
- `src/machine/` must not import from `src/config/` or `src/rails/`.

## Additional Verification for This Subtree

Apply the repository-wide verification rules first. In addition:

```sh
npx vitest run --project unit src/machine/
npm run test:architecture
npm run check
```

For topology changes (new/removed phases), also run:

```sh
npx vitest run --project unit src/rails/
npx vitest run --project integration
```
