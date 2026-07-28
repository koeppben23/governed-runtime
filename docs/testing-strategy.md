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

The `mutation` job runs StrykerJS mutation testing against 46 security-critical
files spanning adapters (persistence-lock + host-adapter), archive digesting,
audit (integrity + completeness + NTP), config (policy + reasons + profile), hooks (HTTP hook server + command pre-tool-use + shared obligation-tracker +
phase-gate), identity (token-verifier + key-resolver), integration
(command-aliases, tool-classification, discovery-risk-paths, architecture challenge/submit, review-validation-mode,
plugin-audit-lifecycle-reason, review enforcement, review orchestrator,
orchestrator detection/output, and agent resolution), logging (error-serialize),
templates (codex-plugin, claude-code-plugin, mandates),
shared canonical JSON, machine (commands, evaluate, guards, next-action, validation-evidence), and
rails (architecture, hydrate, review, review-decision, ticket). It uploads a
mutation report artifact (`reports/mutation/`) and enforces the `break: 80`
threshold in `stryker.conf.json` when the scheduled/release/manual mutation
workflow runs. It is intentionally not a pull-request required check; see
`.github/BRANCH-PROTECTION.md`.

## Test Organization by Layer

| Directory            | What It Tests                                                 |
| -------------------- | ------------------------------------------------------------- |
| `src/machine/`       | State transitions, guards, evaluate, next-action, invariants  |
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

FlowGuard uses [StrykerJS](https://stryker-mutator.io/) (v9.6.1) for mutation testing
on security-critical code paths. Mutation testing validates that tests actually
detect semantic errors, not just that code is executed (coverage alone cannot prove this).

### Threshold And Admission Rule

The canonical Stryker gate applies an aggregate `break: 80` threshold across all
mutated modules (`stryker.conf.json`). There are no per-area lower thresholds.

For integrity-critical modules, FlowGuard additionally requires an individual
targeted score of at least 80 before a module is admitted to the canonical
mutate scope. This admission rule is verified through a targeted `--mutate` run;
it is not a separate Stryker configuration or a lower per-area threshold.

`StringLiteral` and `ArrayDeclaration` mutators are excluded globally because
they produce low-signal literal churn in governance template and schema code;
they are not a per-area carve-out.

### Scope

46 files are mutated, covering the fail-closed governance core
(see `stryker.conf.json` for the canonical list):

| Area                                                                                                                                                                                                                                                                                                                             | Files  | Representative score            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------- |
| Adapters (`persistence-lock`, `host-adapter`)                                                                                                                                                                                                                                                                                    | 2      | (see latest report)             |
| Archive (`content-digest`)                                                                                                                                                                                                                                                                                                       | 1      | (see latest report)             |
| Audit (`integrity`, `completeness`, `ntp-check`)                                                                                                                                                                                                                                                                                 | 3      | (see latest report)             |
| Config (`policy`, `reasons`, `profile`)                                                                                                                                                                                                                                                                                          | 3      | (see latest report)             |
| MCP (`execution-limiter`)                                                                                                                                                                                                                                                                                                        | 1      | (see latest report)             |
| Hooks (`http-server`, `pre-tool-use`, `shared/obligation-tracker`, `shared/phase-gate`)                                                                                                                                                                                                                                          | 4      | (see latest report)             |
| Identity (`token-verifier`, `key-resolver`)                                                                                                                                                                                                                                                                                      | 2      | (see latest report)             |
| Integration (`command-aliases`, `tool-classification`, `discovery-risk-paths`, architecture challenge/submit, `tools/review-validation-mode`, `tools/review-validation`, `tools/review-validation-host-task`, `plugin-audit-lifecycle-reason`, review enforcement/findings-consistency/orchestrator/detection/output/resolution) | 15     | (see latest report)             |
| Templates (`codex-plugin`, `claude-code-plugin`, `mandates`)                                                                                                                                                                                                                                                                     | 3      | (see latest report)             |
| Shared (`canonical-json`)                                                                                                                                                                                                                                                                                                        | 1      | (see latest report)             |
| Logging (`error-serialize`)                                                                                                                                                                                                                                                                                                      | 1      | (see latest report)             |
| Machine (`commands`, `evaluate`, `guards`, `next-action`, `validation-evidence`)                                                                                                                                                                                                                                                 | 5      | (see latest report)             |
| Rails (`architecture`, `hydrate`, `review`, `review-decision`, `ticket`)                                                                                                                                                                                                                                                         | 5      | (see latest report)             |
| **Total**                                                                                                                                                                                                                                                                                                                        | **46** | uploaded as `reports/mutation/` |

Per-file mutation scores are produced fresh in CI; consult the latest
`reports/mutation/` artifact for current numbers.
`stryker.conf.json` excludes `StringLiteral` and `ArrayDeclaration` mutators to
avoid low-signal literal churn and declarative table rewrites while keeping the
security-critical target list and `break: 80` gate intact.

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

### Running Locally

```bash
npm run mutation    # Runs scripts/stryker-patch.js pre-flight + stryker run
```

The pre-flight script patches `@stryker-mutator/vitest-runner` to use `pool=forks`
(for `process.chdir()` compatibility). This is scoped exclusively to mutation testing.
