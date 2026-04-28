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

## Integration Tiers (T1–T5)

Integration and smoke tests are organized into tiers of decreasing governance criticality:

| Tier   | Name                         | File                                          | What It Proves                                                       |
| ------ | ---------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| **T1** | Regulated Mode Critical Path | `integration/regulated-e2e.test.ts`           | Full READY→DONE chain in regulated mode with human gates             |
| **T2** | Policy Mode Matrix           | `integration/policy-matrix.test.ts`           | All policy modes (solo/team/regulated) produce correct gate behavior |
| **T3** | Audit & Archive Integrity    | `integration/audit-archive-integrity.test.ts` | Hash-chain integrity, archive verify, completeness scoring           |
| **T4** | Tool/Handler Contract        | `integration/cli-contract.test.ts`            | Every tool call returns expected shape, errors are structured        |
| **T5** | CLI Smoke                    | `cli/cli-contract-smoke.test.ts`              | Built CLI entry point starts, routes commands, exits cleanly         |

Additionally, `integration/identity-policy-e2e.test.ts` proves the identity-policy
enforcement chain (actor resolution, assurance tiers, policy snapshot flow-through).

## CI Job Mapping

Each CI job maps to exactly one npm script for clear diagnosis:

| CI Job             | npm Script                    | Scope                                                   | Requires Build |
| ------------------ | ----------------------------- | ------------------------------------------------------- | -------------- |
| **unit**           | `npm run test:unit`           | All `*.test.ts` outside `integration/` and CLI smoke    | No             |
| **integration**    | `npm run test:integration`    | All `src/integration/**/*.test.ts` (T1–T4 + tool tests) | No             |
| **smoke**          | `npm run test:smoke`          | CLI contract smoke (T5) + ACP smoke                     | Yes            |
| **install-verify** | `npm run test:install-verify` | Tarball pack/install/doctor verification                | Yes            |
| **mutation**       | `npm run mutation`            | StrykerJS mutation testing for security-critical paths  | No             |

The `smoke` job also requires the OpenCode CLI (`opencode-ai`) for ACP tests.
The `install-verify` job runs cross-platform (Linux, macOS, Windows).

Additional CI jobs (not test-focused): `typecheck`, `lint`, `format`, `build`,
`audit`, `actionlint`, `secrets-scan`, `codeql-sast`, `security-policy`, `install`.

The `mutation` job runs StrykerJS mutation testing against three security-critical
files (`guards.ts`, `evaluate.ts`, `token-verifier.ts`) and uploads a mutation
report artifact (`reports/mutation/`). It is non-blocking (`continue-on-error: true`)
with a `break: 85` threshold enforced by `stryker.conf.json`.

## Test Organization by Layer

| Directory           | What It Tests                                                 | Count |
| ------------------- | ------------------------------------------------------------- | ----- |
| `src/machine/`      | State transitions, guards, evaluate, next-action              | 5     |
| `src/rails/`        | Rail executors (hydrate, plan, review, implement, etc.)       | 6     |
| `src/state/`        | Schema validation, evidence structures                        | 1     |
| `src/config/`       | Policy resolution, profiles, policy snapshots                 | 3     |
| `src/adapters/`     | Persistence, workspace, git, actor resolution                 | 3     |
| `src/audit/`        | Hash-chain, integrity, completeness, query, summary           | 1     |
| `src/discovery/`    | Collectors (stack, topology, surfaces, signals), orchestrator | 13    |
| `src/identity/`     | Actor context resolution                                      | 1     |
| `src/logging/`      | File sink, structured logging                                 | 1     |
| `src/cli/`          | CLI install, doctor, templates, smoke                         | 7     |
| `src/integration/`  | Tool handlers, governance chains, plugin, tiers T1–T4         | 31    |
| `src/architecture/` | Dependency boundary rules, import analysis                    | 1     |

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

Three files are mutated, selected for their role in fail-closed governance:

| File                             | Role                                             | Baseline Score |
| -------------------------------- | ------------------------------------------------ | :------------: |
| `src/machine/guards.ts`          | Guard predicates — first match wins, ERROR first |      100%      |
| `src/machine/evaluate.ts`        | State evaluator — pure function, no side effects |     93.33%     |
| `src/identity/token-verifier.ts` | JWT token verification (P35a)                    |     74.42%     |
| **Overall**                      |                                                  |   **85.71%**   |

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
