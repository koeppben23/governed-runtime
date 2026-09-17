# Testing Strategy

FlowGuard uses a structured, multi-layer test strategy.
Every test suite declares its coverage categories in a `@test-policy` doc comment.

## Test Categories

Every test file should cover five categories where applicable:

| Category   | Purpose                                   | Example                                       |
| ---------- | ----------------------------------------- | --------------------------------------------- |
| **HAPPY**  | Correct input produces correct output     | Hydrate creates session with READY phase      |
| **BAD**    | Invalid/malicious input is rejected       | Missing ticket throws, corrupt state blocked  |
| **CORNER** | Boundary conditions, edge of valid domain | Empty plan sections, max-length strings       |
| **EDGE**   | Environmental or timing-dependent         | No git remote, concurrent sessions, disk full |
| **PERF**   | Performance stays within budget           | State I/O round-trip < 50 ms, evaluate < 1 ms |

Performance budgets are defined in `src/test-policy.ts` with CI-aware multipliers
(2x compute, 3x I/O-bound) to account for shared runner variability.

## Test Tiers (T1–T5)

Unit, integration, and smoke tests are organized into tiers of decreasing governance criticality:

| Tier   | Name                        | File                                              | What It Proves                                                             |
| ------ | --------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| **T1** | State Machine Invariants    | `machine/state-machine-invariants.test.ts`        | Terminal phase blocks, determinism, command-policy subset, policy variance |
| **T2** | Actor Assurance Matrix      | `identity/actor-assurance-matrix.test.ts`         | Assurance tiers, identity-provider mode cases, fail-closed unknown actors  |
| **T3** | Policy Snapshot Regression  | `integration/policy-snapshot-regression.test.ts`  | Snapshot authority, legacy normalization, hydrate persistence              |
| **T4** | Audit/Archive Tamper Matrix | `integration/audit-archive-tamper-matrix.test.ts` | Archive tamper cases, regulated strict checks, archive integrity           |
| **T5** | Session State Upgrade       | `integration/session-state-upgrade.test.ts`       | Legacy session-state fixtures and policy snapshot normalization            |

Additionally, `integration/identity-policy-e2e.test.ts` proves the identity-policy
enforcement chain (actor resolution, assurance tiers, policy snapshot flow-through).

## CI Job Mapping

Each CI job maps to exactly one npm script for clear diagnosis:

| CI Job               | npm Script                      | Scope                                                                                   | Requires Build |
| -------------------- | ------------------------------- | --------------------------------------------------------------------------------------- | -------------- |
| **unit**             | `npm run test:unit`             | All `*.test.ts` outside `integration/`, including T1 and T2                             | No             |
| **coverage**         | `npm run test:coverage:ci`      | Unit + integration under v8 coverage; enforces aggregate 80% threshold                  | No             |
| **integration-perf** | `npm run test:integration:perf` | All integration PERF tests without v8 instrumentation                                   | No             |
| **smoke**            | `npm run test:smoke`            | Built CLI contract smoke and ACP smoke                                                  | Yes            |
| **install-verify**   | `npm run test:install-verify`   | Tarball pack/install/doctor verification                                                | Yes            |
| **mutation**         | `npm run mutation`              | StrykerJS mutation testing for security-critical paths on weekly/release/manual cadence | No             |
| **actions-pinning**  | `npm run check:actions-pinned`  | Workflow and local-action `uses:` refs are immutable SHAs or Docker digests             | No             |

The `smoke` job also requires the OpenCode CLI (`opencode-ai`) for ACP tests.
The `install-verify` job runs cross-platform (Linux, macOS, Windows).

Additional CI jobs (not test-focused): `typecheck`, `lint`, `format`, `build`,
`audit`, `actionlint`, `actions-pinning`, `secrets-scan`, `codeql-sast`,
`security-policy`, `install`.

The `typecheck` job runs `npm run check`, which executes both `check:prod` and
`check:tests`. `check:prod` compiles production sources through `tsconfig.json`.
`check:tests` typechecks the complete source graph in the test/configuration
compilation context through `tsconfig.test.json`, including the approved
root-level Vitest configuration files. The test configuration inherits the
production compiler rules and does not introduce ambient Vitest globals;
existing explicit Vitest imports remain the test API authority.

The `actions-pinning` job enforces the CI supply-chain contract for workflow and
local composite-action dependencies: external GitHub Actions must use full
40-character lowercase commit SHAs, local actions under `./` are allowed, local
and Docker actions are allowed only when pinned by `sha256` digest.

The `mutation` job runs StrykerJS mutation testing against 86 security-critical
files spanning adapters (persistence-lock, host-adapter, persistence, IP validation),
archive creation,
publication, inventory validation, and digesting,
audit (integrity + completeness + NTP + types), config (policy + policy snapshot + reasons + profile), hooks (HTTP hook server + command pre-tool-use + shared obligation-tracker +
phase-gate), identity (token-verifier + key-resolver), integration
(installed-commands, tool-classification, discovery-risk-paths, pre-implementation challenge, architecture submit, review-validation-mode,
plugin-audit, plugin-audit-reconcile, plugin-beforehooks, plugin-afterhooks, plugin-helpers, audit-outbox, plugin-audit-lifecycle-reason, review enforcement, review orchestrator,
orchestrator detection/output, dispatch signal, and agent resolution), logging (error-serialize),
templates (codex-plugin, claude-code-plugin, mandates),
shared canonical JSON, machine (commands, evaluate, guards, workflow-directive, validation-evidence), and
rails (architecture, hydrate, review, URL review transport, review-decision, review-evidence-resolution,
ticket). It uploads a
mutation report artifact (`reports/mutation/`) and enforces the `break: 80`
threshold in `stryker.conf.json` when the scheduled/release/manual mutation
workflow runs. It is intentionally not a pull-request required check; see
`.github/BRANCH-PROTECTION.md`.

## Test Organization by Layer

| Directory            | What It Tests                                                 |
| -------------------- | ------------------------------------------------------------- |
| `src/machine/`       | State transitions, guards, evaluate, workflow directives      |
| `src/rails/`         | Rail executors (hydrate, plan, review, implement, etc.)       |
| `src/state/`         | Schema validation, evidence structures                        |
| `src/config/`        | Policy resolution, profiles, policy snapshots                 |
| `src/adapters/`      | Persistence, workspace, git, actor resolution                 |
| `src/audit/`         | Hash-chain, integrity, completeness, query, summary           |
| `src/discovery/`     | Collectors (stack, topology, surfaces, signals), orchestrator |
| `src/identity/`      | Actor context resolution and assurance enforcement            |
| `src/logging/`       | File sink, structured logging                                 |
| `src/cli/`           | CLI install, doctor, templates, smoke                         |
| `src/integration/`   | Tool handlers, governance chains, plugin, archive, migration  |
| `src/architecture/`  | Dependency boundary rules, import analysis                    |
| `src/documentation/` | Documentation contract checks                                 |

## Running Tests Locally

```bash
# Full suite
npm test

# TypeScript: production and complete test/configuration contexts
npm run check

# TypeScript: individual contexts
npm run check:prod
npm run check:tests

# By layer
npm run test:unit          # Pure logic, no build needed
npm run test:integration   # Governance chains

# Smoke (requires build)
npm run build && npm run test:smoke

# Install verification (requires build)
npm run build && npm run test:install-verify

# Single file
npx vitest run src/rails/review.test.ts

# Watch mode
npm run test:watch
```

## Performance Budget Reference

Authoritative values are in `src/test-policy.ts` (constant `PERF_BUDGETS`). CI
runs apply a per-environment multiplier (`CI_MULTIPLIER` for compute,
`PERF_BUDGET_FACTOR` for I/O-bound paths) to reduce flakiness on shared
runners. Representative budgets at local-development baseline:

| Operation                              | Local budget (see `src/test-policy.ts`)       |
| -------------------------------------- | --------------------------------------------- |
| `evaluate()` call (`evaluateSingleMs`) | 1.5 ms × `CI_MULTIPLIER`                      |
| Guard predicate (`guardPredicateMs`)   | 3 ms × `CI_MULTIPLIER` × `PERF_BUDGET_FACTOR` |
| State serialize/deserialize            | ~5 ms (see `serializeRoundtripMs`)            |
| State I/O round-trip                   | ~50 ms (see `stateIoRoundtripMs`)             |
| Audit chain verify (1000 events)       | ~100 ms (see `auditChainVerifyMs`)            |

`initWorkspace()` and `runDiscovery()` do not have declared budgets in
`PERF_BUDGETS` at this revision; treat their cost as advisory rather than
gated.

## Mutation Testing

FlowGuard uses [StrykerJS](https://stryker-mutator.io/) (v10) for mutation testing
on security-critical code paths. Mutation testing validates that tests actually
detect semantic errors, not just that code is executed (coverage alone cannot prove this).

### Threshold And Admission Rule

The canonical Stryker gate applies an aggregate `break: 80` threshold across all
mutated modules (`stryker.conf.json`). There are no per-area lower thresholds.

Admission policy (applied per profile): Targeted runs are diagnostic only.
Admission evidence is the profile full run. In that run the aggregate score
must meet the break threshold and every mutated target must meet the
per-target break threshold. `scripts/verify-mutation-admission.mjs --profile <profile>`
reads the profile's `reports/mutation/mutation.json` and fails closed on missing
targets, invalid mutants, unknown statuses, or per-target/aggregate scores
below the threshold. Admission records are historical and immutable; later runs
never rewrite them.

The machine-readable scope authority is
`src/architecture/__tests__/mutation-authority-inventory.ts`. It classifies
every authority under the declared roots as `required`, `admission-backlog`, or
`not-mutation-suitable`, and the architecture guard enforces
`required ⊆ mutate`, reverse closure per profile, and coverage of every
production file under an authority root.

`StringLiteral`, `ArrayDeclaration`, and `Regex` mutators are excluded globally
because they produce low-signal literal churn in governance template and schema
code. Focused boundary profiles may enable a globally excluded mutator where it
protects a security-relevant literal: `stryker.identity-jwks.conf.json` enables
`StringLiteral` for the remote-JWKS redirect policy.

### Scope

86 files are mutated in the base profile, covering the fail-closed governance
core (see `stryker.conf.json` for the canonical list; the authority inventory
above is the classification authority):

| Area                                                                                                                                        | Files  | Representative score            |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------- |
| Adapters (`persistence-lock`, `host-adapter`, `persistence`, `persistence-audit`, `ip-validation`)                                          | 5      | see `reports/mutation/`         |
| Archive (`content-digest`, archive creation, publication, tar/manifest inspection, chain and helper verification)                           | 8      | see `reports/mutation/`         |
| Audit (`integrity`, `completeness`, `ntp-check`, `types`, timestamp and RFC3161 verification)                                               | 7      | see `reports/mutation/`         |
| Audit ProofGraph (`evaluate`, `gate`, evidence binders, `enforcement-projection`)                                                           | 6      | see `reports/mutation/`         |
| Integration ProofGraph (`claim-contract`, `materialize-contract`)                                                                           | 2      | see `reports/mutation/`         |
| Config (`policy`, `policy-snapshot`, `reasons`, `profile`)                                                                                  | 4      | see `reports/mutation/`         |
| MCP (`execution-limiter`, `session-resolver`, `tool-adapter`)                                                                               | 3      | see `reports/mutation/`         |
| Hooks (`http-server`, `pre-tool-use`, `shared/obligation-tracker`, `shared/phase-gate`)                                                     | 4      | see `reports/mutation/`         |
| Identity (`token-verifier`, `key-resolver`)                                                                                                 | 2      | see `reports/mutation/`         |
| Integration (plugin hooks, audit outbox, review-validation tools, `plugin-workspace`, `plugin`, `runtime-lease`)                            | 18     | see `reports/mutation/`         |
| Integration Review (`enforcement`, `findings-consistency`, `challenge-consistency`, `challenge-binding`, agent resolution, dispatch signal) | 6      | see `reports/mutation/`         |
| State (`evidence-mutation-episode`)                                                                                                         | 1      | see `reports/mutation/`         |
| Verification/Discovery (`execution-subject`, `verification-planner`)                                                                        | 2      | see `reports/mutation/`         |
| Templates (`codex-plugin`, `claude-code-plugin`, `mandates`)                                                                                | 3      | see `reports/mutation/`         |
| Shared (`canonical-json`)                                                                                                                   | 1      | see `reports/mutation/`         |
| Logging (`error-serialize`)                                                                                                                 | 1      | see `reports/mutation/`         |
| Machine (`commands`, `evaluate`, `guards`, `workflow-directive`, `validation-evidence`)                                                     | 5      | see `reports/mutation/`         |
| Rails (`architecture`, `hydrate`, `review`, `review-url`, `review-decision`, `ticket`, plan and review evidence)                            | 8      | see `reports/mutation/`         |
| **Total**                                                                                                                                   | **86** | uploaded as `reports/mutation/` |

Per-file mutation scores are produced fresh in CI; consult the latest
`reports/mutation/` artifact for current numbers.
`stryker.conf.json` excludes `StringLiteral`, `ArrayDeclaration`, and `Regex`
mutators to avoid low-signal literal churn and declarative table rewrites while
keeping the security-critical target list and `break: 80` gate intact. The
2026-08-16 full-suite run scores 82.88% overall against `break: 80`.

### CI Enforcement

The scheduled/release/manual `mutation` workflow is blocking for that workflow
run. It is not a pull-request required check. A mutation score below the
configured `break: 80` threshold (`stryker.conf.json`) fails the mutation job.
Survivor analysis remains part of normal security-critical test maintenance.

### Interpreting Results

- **Killed**: Mutant was detected by a test assertion.
- **Survived**: Mutant was not detected — test gap to address.
- **CompileError**: Mutant was rejected by the TypeScript checker. The count varies per mutation run; see the HTML report under `reports/mutation/` for the current run's numbers. CompileError results are expected in TypeScript-heavy governance code because literal unions, strict object shapes, and typed return contracts reject many invalid mutations before tests run.
- **Timeout**: Mutant caused infinite loop or excessive runtime — also detected.

### Admission Backlog

Every authority that is not yet in a mutate profile is listed here explicitly
(the machine-readable authority is
`src/architecture/__tests__/mutation-authority-inventory.ts`). A target leaves
this backlog only through a profile full run that proves the per-target and
aggregate thresholds; a score below the threshold never converts a target into
`not-mutation-suitable` by itself.

Candidate authorities awaiting admission (basis profile unless noted):

- `src/machine/topology.ts`
- `src/config/flowguard-config.ts`
- `src/audit/canonical-digest.ts`
- `src/audit/constant-time.ts`
- `src/adapters/git.ts`
- `src/adapters/frozen-repository.ts`
- `src/adapters/implementation-base-authority.ts`
- `src/adapters/implementation-entry-guard.ts`
- `src/state/runtime-lease.ts`
- `src/state/schema.ts`
- `src/state/policy-mode.ts`
- `src/shared/hashing.ts`
- `src/redaction/export-redaction.ts`
- `src/integration/review/reviewed-digest.ts`
- `src/integration/review/findings-hash.ts`
- `src/integration/tools/record-mutation-evidence.ts`
- `src/integration/tools/reconcile-mutation-episode.ts`
- `src/integration/plugin-mutation-episodes.ts`
- `src/mcp-server/server.ts`
- `src/mcp-server/schema-converter.ts`
- `src/hooks/post-tool-use.ts`

Evidence-layer candidates with a recorded diagnostic result (a targeted run is
diagnostic only; these targets must close their test gaps first):

- `src/state/evidence-validation.ts` (18.68%)
- `src/integration/review/shared-helpers.ts` (68.66%)
- `src/integration/tools/run-check-result.ts` (0.00%)

Reason-catalog authorities (base-regime diagnostic required before admission):

- `src/config/reasons-architecture.ts`
- `src/config/reasons-envelope.ts`
- `src/config/reasons-infra.ts`
- `src/config/reasons-mutation.ts`
- `src/config/reasons-precondition.ts`
- `src/config/reasons-proofgraph.ts`
- `src/config/reasons-validation.ts`
- `src/config/reasons-validation-observation.ts`
- `src/config/reasons-validation-review.ts`
- `src/config/reasons-validation-structured.ts`

Deep authority expansion bundle:

- `src/adapters/persistence-core.ts`
- `src/adapters/persistence-config.ts`
- `src/config/policy-resolver.ts`
- `src/config/policy-central.ts`
- `src/config/policy-ci.ts`
- `src/config/policy-types.ts`
- `src/config/profile-types.ts`
- `src/audit/proofgraph/mutation-report.ts`
- `src/audit/proofgraph/mutation-binder.ts`

Mandates profile: `src/rendering/mandates-renderer.ts`.

Deferred surfaces (whole roots behind the admission gate):
`src/config/**`, `src/state/**`, `src/shared/**`, `src/audit/**`,
`src/adapters/**`, `src/identity/**`, `src/verification/**`, `src/discovery/**`,
`src/logging/**`, `src/hooks/**`, `src/mcp-server/**`, `src/templates/**`,
`src/presentation/**`, `src/integration/**`.

Explicitly not mutation-suitable:

- `src/config/reasons-types.ts` — type-only module.
- `src/shared/policy-digest.ts` — pure re-export.
- `src/machine/command-help.ts` — static help text projection.

### Running Locally

```bash
npm run mutation    # Runs scripts/stryker-patch.js pre-flight + base profile
node scripts/verify-mutation-admission.mjs --profile base
```

The pre-flight script applies version-guarded workarounds for
`@stryker-mutator/vitest-runner@10.0.0`: `pool=forks` for `process.chdir()`
compatibility and Vitest 5's `" > "` nested-test separator so Stryker's per-test
filter selects the intended tests. This is scoped exclusively to mutation testing.
It fails if the installed runner, Vitest major, or runner artifact shape is not
recognized; remove the workaround when upgrading to a Stryker release with the
upstream Vitest 5 fix.

The remote-JWKS profile runs on pull requests that change its source, tests, or
configuration:

```bash
node scripts/stryker-patch.js && npx stryker run stryker.identity-jwks.conf.json
node scripts/verify-mutation-admission.mjs --profile identity-jwks
```

The mandates profile runs on pull requests that change mandate surfaces:

```bash
node scripts/stryker-patch.js && npx stryker run stryker.mandates.conf.json
node scripts/verify-mutation-admission.mjs --profile mandates
```

The human-projection profile is reusable locally but has no dedicated CI
workflow yet; adding one requires a full-profile run that proves every target
meets the per-target threshold first:

```bash
node scripts/stryker-patch.js && npx stryker run stryker.human-projection.conf.json
node scripts/verify-mutation-admission.mjs --profile human-projection
```
