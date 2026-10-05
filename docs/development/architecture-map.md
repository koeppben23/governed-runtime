# Developer Architecture Map

Where a change belongs, which authority owns it, and which enforced checks must
be updated in the same change. Process rules live in
[CONTRIBUTING.md](../../CONTRIBUTING.md); the test layers are described in
[Testing Strategy](../testing-strategy.md); each layer adds local rules in its
nested `AGENTS.md`. For a worked example, see
[Your First Change](./first-change.md).

## Layer entry points

The canonical authority list lives in
[`AGENTS.md` § Canonical Authorities](../../AGENTS.md#canonical-authorities).
The table below names entry points for each change type and is a projection of
that list, not a second authority list.

| You are changing...                         | Start here                                      | Owning authority                                                     |
| ------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| Workflow/state transitions, guards          | `src/machine/`                                  | `src/machine/evaluate.ts`, `src/machine/guards.ts`                   |
| Session/evidence schemas, persistence shape | `src/state/`                                    | `src/state/schema.ts`, `src/state/evidence*.ts`                      |
| File I/O, Git, archive, host persistence    | `src/adapters/`                                 | layer-local modules (`persistence*.ts`, `workspace/`)                |
| Commands/tools exposed to the host agent    | `src/integration/tools/`                        | `src/integration/tools/index.ts`, `src/integration/tool-names.ts`    |
| Independent review pipeline                 | `src/integration/review/`                       | review zones + `src/architecture/support/review-zone-policy.ts`      |
| Audit event kinds and outbox                | `src/audit/`, `src/integration/audit-outbox.ts` | `src/audit/event-core.ts`, `src/audit/types.ts`                      |
| Blocked reason codes/copy                   | `src/config/reasons*.ts`                        | `src/config/reasons.ts` (barrel) + category modules                  |
| Installed mandates/commands                 | `src/templates/`                                | `src/templates/mandates.ts`, `src/integration/installed-commands.ts` |
| Hashing/canonical serialization             | `src/shared/`                                   | `src/shared/hashing.ts`, `src/shared/canonical-json.ts`              |

## Versioned contracts

Persisted and externally referenced contracts carry a hard version. The table
below is navigation; the named source constants are authority.

| Contract             | Current                         | Authority                                            |
| -------------------- | ------------------------------- | ---------------------------------------------------- |
| Session state        | `v10`                           | `src/state/schema.ts`                                |
| Assurance epoch      | `assurance-epoch.v3`            | `src/state/schema.ts`                                |
| State digest         | `state-digest.v2`               | `src/state/schema.ts`                                |
| Audit chain          | `audit-chain.v3`                | `src/state/schema.ts`, `src/state/evidence-audit.ts` |
| Policy digest        | `policy-digest.v4`              | `src/state/evidence-identifiers.ts`                  |
| Archive manifest     | `archive-manifest.v4`           | `src/archive/types.ts`                               |
| Review assurance     | `review-assurance.v7`           | `src/state/evidence-review.ts`                       |
| Peer-review evidence | `standalone-review-evidence.v2` | `src/state/peer-review.ts`                           |
| Discovery            | `discovery.v2`                  | `src/discovery/types.ts`                             |

Version tables are navigation. The named source constants are authority.

Contract replacement is a hard version boundary: the old shape is rejected at
the read boundary, with no read migration and no defaulting. See
[Upgrade and Rollback](../upgrade-rollback.md) and the superseded
[Schema Migration Architecture](../architecture/schema-migration.md).

## Change-type checklists

### New feature or tool

1. Place production files by the placement authority — every file under
   `src/integration/` needs an entry with exactly **one owner**
   (`src/architecture/support/integration-placement-manifest.ts`). `zone` and
   `targetZone` are derived from the path and owner; the physical directory must
   match the owner's target zone.
2. New tools validate inputs against canonical schemas, route through the state
   machine, return typed results, and register in `src/integration/tools/index.ts`
   and `src/integration/tool-names.ts`.
3. Add the owning contract tests (tool layer: `--project integration`).
4. Run `npm run test:architecture` — placement projection, module direction, and
   tool-name SSOT are enforced there.

### Review change (`src/integration/review/`)

- `Mode B` is the historical/internal test label for the explicit review-verdict
  submission path used by plan and architecture; it is not a policy mode or a
  fourth product flow. The `test:review-modeb-contract` script and the
  contract-smoke workflow keep the label.
- Zones: `dispatch/`, `obligations/`, `context/`, `observations/`, `evidence/`,
  `validation/`, `prompting/`, `enforcement/`. The review bounded context has no
  barrel facade; production code imports the concrete subzone authority. The
  removed `review/index.ts` is guarded against reintroduction.
- The allowed zone graph is frozen in
  `src/architecture/support/review-zone-policy.ts` (`observed == declared`).
  The complete zone graph is acyclic. Moving a file requires updating the
  declared edges and the zone budgets in the placement authority in the same
  change.
- Validation returns domain failures (`ReviewValidationFailure`); serialization
  happens only in `review/validation/review-validation-failure.ts`, invoked by
  the tool adapters.
- Critical components are mutation-admitted: follow the add/move/delete and
  admission procedure under "Add, move, or delete a production file" below —
  the mutation inventory, Stryker selector, covering suite, admission record,
  and registry projection move together. Do not update only the inventory and
  `stryker.conf.json`.
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

### Add, move, or delete a production file

The first steps apply to every production file under `src/`. The placement,
review-zone, and mutation steps are conditional: placement applies to
`src/integration/**`, review zone edges to `src/integration/review/**`, and
mutation scope only to mutation-suitable authorities.

**Add**

1. Keep files within the size budgets (`650` production / `2000` test LOC).
2. A new top-level module needs a **module classification** entry in
   `src/architecture/support/module-classification.ts` and a direction in
   `MODULE_DEPENDENCY_POLICY`
   (`src/architecture/support/module-dependency-policy.ts`).
3. Run `npm run test:architecture`, `npm run check`, `npm run lint:strict`.
4. `src/integration/**`: add exactly one `{ file, owner }` **placement entry**
   to `INTEGRATION_PLACEMENT`
   (`src/architecture/support/integration-placement-manifest.ts`). A new
   directory needs a zone in `INTEGRATION_PLACEMENT_ZONES` and an owner in
   `INTEGRATION_OWNERS`; the physical directory must equal the owner's
   `targetZone`. Review zones carry a **growth target**
   (`targetProductionFiles`): growth beyond the target requires one
   `budgetExceptions` entry per additional file with an explicit reason,
   otherwise decompose the zone.
5. `src/integration/review/**`: declare the observed zone edge in
   `DECLARED_REVIEW_ZONE_EDGES` (`review-zone-policy.ts`); the zone graph must
   stay acyclic.
6. Mutation-suitable authority: enter the scope as an `admission-candidate` in
   the **mutation inventory**
   (`src/architecture/support/mutation-authority-inventory-data.ts`) with its
   Stryker selector in `stryker*.conf.json` and its covering suite in
   `vitest.stryker*.config.ts`, or name it in the `admission-backlog`. A new
   inventory entry is not an admission.

**Admit a mutation candidate**

1. Run the profile full run; admission evidence is the full run, never a
   targeted run.
2. Verify the manifest and admit only the new selectors via
   `--require-selectors`; `--emit-admission` emits the record from the verified
   run.
3. Move the inventory entry to `required` with the immutable **admission
   record** in `mutation-admission-records.ts`, then regenerate the
   `admittedSelectors` projection with
   `node scripts/generate-mutation-registry.mjs --write` — never by hand.
   `npm run check:mutation-registry` (part of the `check` chain) detects
   projection drift. The record remains the authority, and the
   mutation reconciliation guard (A11) independently requires active
   admissions, records, and the registry to match exactly.
   The generator is a development tool for the pinned toolchain
   (`.node-version`, Node >= 22.22.2, TypeScript type stripping); the published
   `engines` range is the consumer contract, not the dev contract.
4. A candidate below the per-target threshold is downgraded instead: remove its
   `mutate` selector from the Stryker config and reclassify the inventory entry
   as `admission-backlog` (A3 requires every `mutate` selector to be `required`
   or `admission-candidate`, and backlog targets must not overlap the mutate
   lists). Harden the target instead of backfilling a record.

**Move**

- General: update the module classification/dependency direction when a
  top-level module moves, and run the checks.
- `src/integration/**`: update the **placement entry** and move the file into
  the owner's `targetZone` directory.
- `src/integration/review/**`: update the declared zone edges.
- Mutation targets: update the Stryker selector, the inventory entry, and the
  covering suite. Admission records are keyed by the exact mutate selector: a
  renamed selector makes the mutation reconciliation guard fail closed and
  needs the dedicated admission decision from the delete case.

**Delete**

- General: remove the module classification entry when the module or entry
  disappears, and run the checks.
- `src/integration/**`: remove the **placement entry**;
  `src/integration/review/**` also removes the declared zone edges.
- Non-admitted mutation scope:
  - `admission-backlog` and `not-mutation-suitable` entries carry no
    `mutateSelector` and no `coveringSuites`: remove the inventory entry.
  - `required` with `legacyBaseline` is in the mutate list with its selector
    and covering suites: remove the entry, its Stryker selector, and its
    covering-suite reference.
- Mutation-admitted target (`required` with an **admission record**): do not
  silently delete. Admission records are historical and immutable, and the
  mutation reconciliation guard requires active admissions, records, and
  `scripts/mutation-profile-registry.json` to match exactly. Choose
  deliberately: keep the file as a mutation target, or make a dedicated
  authority change across `mutation-authority-inventory-data.ts`,
  `mutation-admission-records.ts`, and
  `scripts/mutation-profile-registry.json`, including the archival decision
  for the historical record.

## Commands

Command selection and the executable verification surface are curated in
[Testing Strategy](../testing-strategy.md); `package.json` is the executable
script authority. Change-specific commands stay in the checklists above.
