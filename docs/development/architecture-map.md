# Developer Architecture Map

Where a change belongs, which authority owns it, and which enforced checks must
be updated in the same change. Process rules live in
[CONTRIBUTING.md](../../CONTRIBUTING.md); the test layers are described in
[Testing Strategy](../testing-strategy.md); each layer adds local rules in its
nested `AGENTS.md`. For a worked example, see
[Your First Change](./first-change.md).

## Layer entry points

| You are changing...                         | Start here                                      | Owning authority                                                     |
| ------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| Workflow/state transitions, guards          | `src/machine/`                                  | `src/machine/evaluate.ts`, `src/machine/guards.ts`                   |
| Session/evidence schemas, persistence shape | `src/state/`                                    | `src/state/schema.ts`, `src/state/evidence*.ts`                      |
| File I/O, Git, archive, host persistence    | `src/adapters/`                                 | layer-local modules (`persistence*.ts`, `workspace/`)                |
| Commands/tools exposed to the host agent    | `src/integration/tools/`                        | `src/integration/tools/index.ts`, `src/integration/tool-names.ts`    |
| Independent review pipeline                 | `src/integration/review/`                       | review zones + `src/architecture/__tests__/review-zone-policy.ts`    |
| Audit event kinds and outbox                | `src/audit/`, `src/integration/audit-outbox.ts` | `src/audit/event-core.ts`, `src/audit/types.ts`                      |
| Blocked reason codes/copy                   | `src/config/reasons*.ts`                        | `src/config/reasons.ts`                                              |
| Installed mandates/commands                 | `src/templates/`                                | `src/templates/mandates.ts`, `src/integration/installed-commands.ts` |
| Hashing/canonical serialization             | `src/shared/`                                   | `src/shared/hashing.ts`, `src/shared/canonical-json.ts`              |

## Change-type checklists

### New feature or tool

1. Place production files by the placement authority — every file under
   `src/integration/` needs an entry with exactly **one owner**
   (`src/architecture/__tests__/integration-placement-policy.ts`). `zone` and
   `targetZone` are derived from the path and owner; the physical directory must
   match the owner's target zone.
2. New tools validate inputs against canonical schemas, route through the state
   machine, return typed results, and register in `src/integration/tools/index.ts`
   and `src/integration/tool-names.ts`.
3. Add the owning contract tests (tool layer: `--project integration`).
4. Run `npm run test:architecture` — placement projection, module direction, and
   tool-name SSOT are enforced there.

### Review change (`src/integration/review/`)

- Zones: `dispatch/`, `obligations/`, `context/`, `observations/`, `evidence/`,
  `validation/`, `prompting/`, `enforcement/`. `review/index.ts` is the facade and
  must never be imported by production code.
- The allowed zone graph is frozen in
  `src/architecture/__tests__/review-zone-policy.ts` (`observed == declared`).
  The complete zone graph is acyclic. Moving a file requires updating the
  declared edges and the zone budgets in the placement authority in the same
  change.
- Validation returns domain failures (`ReviewValidationFailure`); serialization
  happens only in `review/validation/review-validation-failure.ts`, invoked by
  the tool adapters.
- Critical components are mutation-admitted:
  `src/architecture/__tests__/mutation-authority-inventory.ts` (owner tests) and
  `stryker.conf.json`. Update both when a target moves.
- Run `npm run test:architecture` and the review contract tests
  (`test:review-host-contract`, `test:review-modeb-contract`).

### State persistence

- Schema and refinements live in `src/state/`; persistence I/O in
  `src/adapters/persistence*.ts`. Persisted states are validated on write
  (fail-closed `PersistenceError`).
- Production code never constructs bare `new Error(...)` at boundaries;
  `npm run test:architecture` enforces typed errors and zero-debt syntax.
- Add/extend the migration or parity test that owns the changed schema.

### Audit

- Event kinds and payloads are owned by `src/audit/event-core.ts` and
  `src/audit/types.ts`; the durable outbox write path is
  `src/integration/audit-outbox.ts`.
- Audit-affecting changes run `src/architecture/__tests__/audit-authority-guard.test.ts`
  and the archive/tamper suites.

### New production file anywhere

1. Add the placement entry (integration subtree) and, for review zones, respect
   the zone budget.
2. Keep files within the size budgets (`650` production / `2000` test LOC).
3. Run `npm run test:architecture`, `npm run check`, `npm run lint:strict`.

## Commands

```sh
npm run check                 # production + test typecheck
npm run lint:strict           # eslint, zero warnings
npm run check:format          # prettier
npm run test:architecture     # dependency, placement, zone, SSOT guards
npm run test:unit             # fast unit project
npx vitest run --project integration
npm run test:scripts          # repository scripts tests
npm run mutation              # admitted mutation targets (slow)
npm run check:doc-drift       # generated docs inventory
```
