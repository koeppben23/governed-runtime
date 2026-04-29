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

| CI Job             | npm Script                    | Scope                                                        | Requires Build |
| ------------------ | ----------------------------- | ------------------------------------------------------------ | -------------- |
| **unit**           | `npm run test:unit`           | All `*.test.ts` outside `integration/`, including T1 and T2  | No             |
| **integration**    | `npm run test:integration`    | All `src/integration/**/*.test.ts`, including T3, T4, and T5 | No             |
| **smoke**          | `npm run test:smoke`          | Built CLI contract smoke and ACP smoke                       | Yes            |
| **install-verify** | `npm run test:install-verify` | Tarball pack/install/doctor verification                     | Yes            |
| **mutation**       | `npm run mutation`            | StrykerJS mutation testing for security-critical paths       | No             |

The `smoke` job also requires the OpenCode CLI (`opencode-ai`) for ACP tests.
The `install-verify` job runs cross-platform (Linux, macOS, Windows).

Additional CI jobs (not test-focused): `typecheck`, `lint`, `format`, `build`,
`audit`, `actionlint`, `secrets-scan`, `codeql-sast`, `security-policy`, `install`.

The `mutation` job runs StrykerJS mutation testing against three security-critical
files (`guards.ts`, `evaluate.ts`, `token-verifier.ts`) and uploads a mutation
report artifact (`reports/mutation/`). It is non-blocking (`continue-on-error: true`)
with a `break: 85` threshold enforced by `stryker.conf.json`.

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

Key thresholds from `src/test-policy.ts`:

| Operation                          | Budget                      |
| ---------------------------------- | --------------------------- |
| `evaluate()` call                  | < 1 ms                      |
| Guard predicate                    | < 2 ms                      |
| State serialize/deserialize        | < 5 ms                      |
| State I/O round-trip               | < 50 ms                     |
| `initWorkspace()`                  | < 50 ms (150 ms on Windows) |
| `runDiscovery()` (typical project) | < 100 ms                    |
| Audit chain verify (1000 events)   | < 100 ms                    |

CI runs apply multipliers to these budgets to reduce flakiness on shared runners.

## Mutation Testing

FlowGuard uses [StrykerJS](https://stryker-mutator.io/) (v9.6.1) for mutation testing
on security-critical code paths. Mutation testing validates that tests actually
detect semantic errors, not just that code is executed (coverage alone cannot prove this).

### Scope

Twelve files are mutated, covering the fail-closed governance core:

| Area                                             | Files  |  Score   |
| ------------------------------------------------ | ------ | :------: |
| Machine (guards, evaluate, commands)             | 3      |  98.77%  |
| Rails (hydrate, review-decision, review, ticket) | 4      |  94.59%  |
| Audit (integrity, completeness)                  | 2      |  95.19%  |
| Config (reasons, policy)                         | 2      |  71.81%  |
| Identity (token-verifier)                        | 1      |  81.40%  |
| **Overall**                                      | **12** | **~89%** |

### CI Enforcement

The `mutation` CI job runs with `continue-on-error: true` — mutation score below the
configured `break` threshold does not block PRs while the score baseline is stabilized:

| Stage       | Threshold   | Blocking?                | Rationale                                         |
| ----------- | ----------- | ------------------------ | ------------------------------------------------- |
| **Current** | `break: 85` | No (`continue-on-error`) | Baseline establishment, CI stability verification |
| **Next**    | `break: 80` | No                       | Score ratchet and survivor analysis complete      |
| **Target**  | `break: 85` | **Yes**                  | Proven stability, blocking enforcement            |

Blocking enforcement requires: ≥10 stable CI mutation runs without flaky failures,
policy.ts survivors analyzed and either killed or documented as equivalent, and
`break` threshold upheld across ≥5 consecutive PRs.

### Interpreting Results

- **Killed**: Mutant was detected by a test assertion.
- **Survived**: Mutant was not detected — test gap to address.
- **CompileError**: Mutant was rejected by the TypeScript checker. The high count (119)
  is expected for TypeScript-heavy governance code: literal unions, strict object
  shapes, and typed return contracts reject many invalid mutations before tests run.
- **Timeout**: Mutant caused infinite loop or excessive runtime — also detected.

### Running Locally

```bash
npm run mutation    # Runs stryker-patch.js pre-flight + stryker run
```

The pre-flight script patches `@stryker-mutator/vitest-runner` to use `pool=forks`
(for `process.chdir()` compatibility). This is scoped exclusively to mutation testing.
