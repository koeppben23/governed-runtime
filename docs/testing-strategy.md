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

Additionally, `integration/identity-policy-e2e.test.ts` proves the P1 identity-policy
enforcement chain (actor resolution, assurance tiers, policy snapshot flow-through).

## CI Job Mapping

Each CI job maps to exactly one npm script for clear diagnosis:

| CI Job             | npm Script                    | Scope                                                   | Requires Build |
| ------------------ | ----------------------------- | ------------------------------------------------------- | -------------- |
| **unit**           | `npm run test:unit`           | All `*.test.ts` outside `integration/` and CLI smoke    | No             |
| **integration**    | `npm run test:integration`    | All `src/integration/**/*.test.ts` (T1–T4 + tool tests) | No             |
| **smoke**          | `npm run test:smoke`          | CLI contract smoke (T5) + ACP smoke                     | Yes            |
| **install-verify** | `npm run test:install-verify` | Tarball pack/install/doctor verification                | Yes            |

The `smoke` job also requires the OpenCode CLI (`opencode-ai`) for ACP tests.
The `install-verify` job runs cross-platform (Linux, macOS, Windows).

Additional CI jobs (not test-focused): `typecheck`, `lint`, `format`, `build`,
`audit`, `actionlint`, `secrets-scan`, `codeql-sast`, `security-policy`, `install`.

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
