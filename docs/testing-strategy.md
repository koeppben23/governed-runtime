# Testing Strategy

FlowGuard uses a structured, multi-layer test strategy.
Every test suite declares its applicable coverage categories in a `@test-policy` doc comment.

## Test Categories

Every test suite should cover the applicable correctness categories:

| Category   | Purpose                                           | Example                                       |
| ---------- | ------------------------------------------------- | --------------------------------------------- |
| **HAPPY**  | Correct input produces correct output             | Hydrate creates session with READY phase      |
| **BAD**    | Invalid/malicious input is rejected               | Missing ticket throws, corrupt state blocked  |
| **CORNER** | Boundary conditions, edge of valid domain         | Empty plan sections, max-length strings       |
| **EDGE**   | Environmental or timing-dependent                 | No git remote, concurrent sessions, disk full |
| **PERF**   | Explicit performance contract stays within budget | State I/O round-trip < 50 ms, evaluate < 1 ms |

`PERF` applies only when the unit has an explicit performance contract. Those tests SHOULD
use the `PERF_BUDGETS` authority with `benchmarkSync` or `benchmarkAsync` where applicable.
Ad-hoc single-invocation wall-clock smoke thresholds without an explicit performance
contract must not act as test gates. Performance budgets use CI-aware multipliers (2x
compute, 3x I/O-bound) to account for shared runner variability.

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

Each CI job maps to its npm script(s) for clear diagnosis:

| CI Job                | npm Script                           | Scope                                                                                                | Requires Build |
| --------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------- |
| **unit**              | `npm run test:unit`                  | All `*.test.ts` outside `integration/`, including T1 and T2                                          | No             |
| **unit (scripts)**    | `npm run test:scripts`               | Repository-internal script tests (`scripts/**/*.test.ts`), run as a second step of the `unit` CI job | No             |
| **unit (assertions)** | `npm run test:assertion-conformance` | Golden assertion-parser conformance, run as a third step of the `unit` CI job                        | No             |
| **coverage**          | `npm run test:coverage:ci`           | Unit + integration under v8 coverage; enforces aggregate 80% threshold                               | No             |
| **integration-perf**  | `npm run test:integration:perf`      | All integration PERF tests without v8 instrumentation                                                | No             |
| **smoke**             | `npm run test:smoke`                 | Built CLI contract smoke and ACP smoke                                                               | Yes            |
| **install-verify**    | `npm run test:install-verify`        | Tarball pack/install/doctor verification                                                             | Yes            |
| **mutation**          | `npm run mutation`                   | StrykerJS mutation testing for security-critical paths on weekly/release/manual cadence              | No             |
| **actions-pinning**   | `npm run check:actions-pinned`       | Workflow and local-action `uses:` refs are immutable SHAs or Docker digests                          | No             |

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

The `mutation` job runs StrykerJS mutation testing against 109 security-critical
files spanning adapters (persistence-lock, host-adapter, persistence, IP validation),
archive creation,
publication, inventory validation, and digesting,
audit (integrity + completeness + NTP + event builders + RFC3161 parse/signer verification),
config (policy snapshot/resolver/central + reasons + profile), hooks (HTTP hook server + command pre-tool-use + shared obligation-tracker +
phase-gate), identity (token-verifier + key-resolver), integration
(installed-commands, tool-classification, discovery-risk-paths, pre-implementation challenge, architecture submit, review-validation-mode,
plugin-audit, services/decision-audit-intent, plugin-audit-reconcile, plugin-beforehooks, plugin-afterhooks, plugin-helpers, audit-outbox, plugin-audit-lifecycle-reason, review enforcement,
dispatch signal, and agent resolution), logging (error-serialize),
templates (codex-plugin, claude-code-plugin, mandates),
shared canonical JSON and hashing, machine (commands, evaluate, guards, workflow-directive, validation-evidence), and
rails (architecture, hydrate, review, URL review transport, review-decision, review-decision-gates, review-evidence-resolution,
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

Architecture correctness is blocking and deterministic: the required
`architecture` check contains no wall-clock pass/fail assertions. Architecture
runtime is observed through the non-blocking `ci-runtime-report` job, not
through timing thresholds inside the suite. `architecture` is a stable
aggregator over `architecture-linux` and `architecture-windows`; the platform
workers are implementation details and are not individual branch-protection
contexts.

## Mutation Testing

FlowGuard uses [StrykerJS](https://stryker-mutator.io/) (v10) for mutation testing
on security-critical code paths. Mutation testing validates that tests actually
detect semantic errors, not just that code is executed (coverage alone cannot prove this).

### Threshold And Admission Rule

The canonical Stryker gate applies an aggregate `break: 80` threshold across all
mutated modules (`stryker.conf.json`). There are no per-area lower thresholds.

Admission policy (applied per profile): Targeted runs are diagnostic only.
Admission evidence is the profile full run. In that run the aggregate score
must meet the break threshold. Newly admitted targets — named explicitly via
`--require-selectors` — must additionally meet the per-target break threshold;
range selectors are scored only over mutants whose `location` lies inside the
declared range. Legacy targets below the per-target threshold are reported as
a note and remain tracked for test hardening. `scripts/verify-mutation-admission.mjs`
validates the report against the mutation-testing-elements structure, requires
the report's file set to match the profile's selectors exactly, and fails
closed on missing targets, invalid mutant shapes, unknown statuses, or
aggregate/required-selector scores below the threshold. `--write-manifest` persists
the profile, config digest, report digest, commit SHA and run timestamp;
`--manifest` re-verifies those bindings against the profile config, the report
bytes and HEAD, and `--emit-admission` refuses to emit without a verified
manifest. Admission records are historical and immutable; later runs never
rewrite them.

The machine-readable scope authority is
`src/architecture/__tests__/mutation-authority-inventory.ts`. It classifies
every authority under the declared roots as `required`, `admission-backlog`, or
`not-mutation-suitable`; the latter is always bound to the profile whose
regime produced the evidence and never excludes a target from other profiles.
The architecture guard enforces `required ⊆ mutate`, reverse closure per
profile, and coverage of every production file under an authority root.

Profile metadata is centralized in `scripts/mutation-profile-registry.json`
(config file, vitest config, report path, manifest path). Each profile writes
its own JSON/HTML report and manifest under `reports/mutation/<profile>/`;
`base` keeps the canonical `reports/mutation/mutation.json` that the product
mutation-evidence tool and ProofGraph ingestion read. A registry closure guard
proves registry, inventory, and on-disk profiles cannot drift apart.

`StringLiteral`, `ArrayDeclaration`, and `Regex` mutators are excluded globally
because they produce low-signal literal churn in governance template and schema
code. Focused boundary profiles may enable a globally excluded mutator where it
protects a security-relevant literal: `stryker.identity-jwks.conf.json` enables
`StringLiteral` for the remote-JWKS redirect policy.

### Scope

109 files are mutated in the base profile, covering the fail-closed governance
core (see `stryker.conf.json` for the canonical list; the authority inventory
above is the classification authority):

| Area                                                                                                                                                                                              | Files   | Representative score            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------- |
| Adapters (`persistence-lock`, `host-adapter`, `persistence`, `persistence-core`, `persistence-config`, `persistence-audit`, `ip-validation`, implementation base freeze/entry)                    | 9       | see `reports/mutation/`         |
| Archive (`content-digest`, archive creation, publication, tar/manifest inspection, chain, artifact-binding, audit-chain, checksum, integrity and helper verification)                             | 12      | see `reports/mutation/`         |
| Audit (`integrity`, `completeness`, `ntp-check`, `event-builders`, timestamp and RFC3161 parse/signer verification)                                                                               | 9       | see `reports/mutation/`         |
| Audit ProofGraph (`evaluate`, `gate`, evidence binders, `enforcement-projection`, mutation report/binder)                                                                                         | 8       | see `reports/mutation/`         |
| Integration ProofGraph (`claim-contract`, `claim-contract-rules`, `materialize-contract`)                                                                                                         | 3       | see `reports/mutation/`         |
| Config (`policy-snapshot`, `policy-resolver`, `policy-central`, `reasons`, `profile`)                                                                                                             | 5       | see `reports/mutation/`         |
| MCP (`execution-limiter`, `session-resolver`, `tool-adapter`, `server`)                                                                                                                           | 4       | see `reports/mutation/`         |
| Hooks (`http-server`, `pre-tool-use`, `post-tool-use`, `shared/obligation-tracker`, `shared/phase-gate`)                                                                                          | 5       | see `reports/mutation/`         |
| Identity (`token-verifier`, `key-resolver`)                                                                                                                                                       | 2       | see `reports/mutation/`         |
| Integration (plugin hooks, mutation evidence tools/episodes, `plugin-workspace`, `plugin`, `runtime-lease`)                                                                                       | 16      | see `reports/mutation/`         |
| Integration Review (`enforcement`, `findings-consistency`, `challenge-consistency`, `challenge-binding`, agent resolution, dispatch signal, review validation x2, findings hash, reviewed digest) | 10      | see `reports/mutation/`         |
| State (`evidence-mutation-episode`)                                                                                                                                                               | 1       | see `reports/mutation/`         |
| Verification/Discovery (`execution-subject`, `verification-planner`)                                                                                                                              | 2       | see `reports/mutation/`         |
| Templates (`codex-plugin`, `claude-code-plugin`)                                                                                                                                                  | 2       | see `reports/mutation/`         |
| Shared (`canonical-json`, `hashing`)                                                                                                                                                              | 2       | see `reports/mutation/`         |
| Logging (`error-serialize`)                                                                                                                                                                       | 1       | see `reports/mutation/`         |
| Machine (`commands`, `evaluate`, `guards`, `workflow-directive`, `validation-evidence`)                                                                                                           | 5       | see `reports/mutation/`         |
| Rails (`architecture`, `hydrate`, `review`, `review-url`, `review-decision`, `review-decision-gates`, `ticket`, plan and review evidence)                                                         | 9       | see `reports/mutation/`         |
| **Total**                                                                                                                                                                                         | **109** | uploaded as `reports/mutation/` |

Per-file mutation scores are produced fresh in CI; consult the latest
`reports/mutation/` artifact for current numbers.
`stryker.conf.json` excludes `StringLiteral`, `ArrayDeclaration`, and `Regex`
mutators to avoid low-signal literal churn and declarative table rewrites while
keeping the security-critical target list and `break: 80` gate intact. The
2026-08-16 full-suite run scores 82.88% overall against `break: 80`.

### CI Enforcement

The scheduled/release/manual `mutation` workflow is blocking for that workflow
run. It is not a pull-request required check. Focused profiles additionally run
as path-filtered pull-request gates: `identity-jwks`, `schemas`, `mandates`,
`event-core`, and `topology`. `human-projection` remains local-only: its full
run leaves `src/presentation/markdown.ts:264-292` below the per-target gate, so
it does not yet prove every target. A mutation score below the
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

- `src/audit/canonical-digest.ts` — 75.00 % (equivalence-limited, thin evidence).
- `src/audit/constant-time.ts` — 66.67 % with all six survivors semantically equivalent.
- `src/adapters/git.ts` — 57.06 % after one focused behavior-test pass (base profile).
- `src/adapters/frozen-repository.ts` — 70.37 % after one focused acquisition-boundary pass (base profile), including a production fix that keeps OVERSIZED_BLOB out of ACQUISITION_FAILED.
- `src/state/schema.ts` — 77.78 % under the schemas profile (peer-review lifecycle residual).
- `src/state/proofgraph-approval.ts` — targeted diagnostic 41.00 % total / 58.57 % covered (base config: 41 killed / 29 survived / 30 no-coverage); the residual is dominated by uncovered certificate-verification branches and schema-method mutants, so the authority stays backlog until its covering suites close that gap.
- `src/redaction/export-redaction.ts` — 63.86 % (equivalence-limited).
- `src/mcp-server/schema-converter.ts` — 100.00 % on one valid mutant; mutant density is insufficient for authority admission (thin evidence).

Evidence-layer candidates with a recorded diagnostic result (a targeted run is
diagnostic only; these targets must close their test gaps first):

- `src/state/evidence-validation.ts` (18.68%)
- `src/integration/review/shared-helpers.ts` (68.66%)
- `src/integration/tools/validation/run-check-result.ts` (0.00%)

Deep authority expansion bundle:

- `src/config/policy-ci.ts` — 100 % on five valid mutants; density too low (thin evidence).
- `src/config/policy-types.ts` — 20 % on five valid mutants; evidence too weak.

Mandates profile: `src/rendering/mandates-renderer.ts` — focused contract pass reached 72.40 % (below the per-target gate); dedicated mandates hardening pass required before admission.

Schemas profile (`stryker.schemas.conf.json`): `src/config/flowguard-config.ts` — admitted 2026-09-17 at 91.11 % on its profile full run; `src/state/schema.ts` reached 77.78 % and remains in the schemas-profile backlog.

Human-projection profile (`stryker.human-projection.conf.json`): full run
2026-09-19 at 85.26 % after the #921 split re-anchored the markdown
finding-render range to `src/presentation/markdown.ts:264-292`. The three static
copy modules above carry no valid mutants and are explicitly not
mutation-suitable for this profile.

Event-core profile (`stryker.event-core.conf.json`): focused authority profile
for `src/audit/event-core.ts` (module-init event-kind authority, chain-hash and
timestamp-finalization contracts). It uses `coverageAnalysis: "all"`,
`ignoreStatic: false` and keeps `StringLiteral` enabled so the format, event-name
and genesis constants are mutated; the base regime excludes literal mutations
and the remaining operator mutations are rejected by the TypeScript checker.
The profile is required and must pass its own full run plus
`verify-mutation-admission.mjs --profile event-core`.

Topology profile (`stryker.topology.conf.json`): focused authority profile for
`src/machine/topology.ts`, the formal state transition table. It uses
`coverageAnalysis: "all"`, `ignoreStatic: false`, keeps `StringLiteral`
enabled, and disables the TypeScript checker because the typed table literals
are the mutation surface. Admitted 2026-09-21 at 99.32 % on the freeze run
(df9f8b4d); the base classification `not-mutation-suitable` stays scoped to
base.

Deferred surfaces (whole roots behind the admission gate):
`src/config/**`, `src/state/**`, `src/shared/**`, `src/audit/**`,
`src/adapters/**`, `src/identity/**`, `src/verification/**`, `src/discovery/**`,
`src/logging/**`, `src/hooks/**`, `src/mcp-server/**`, `src/templates/**`,
`src/presentation/**`, `src/integration/**`.

Explicitly not mutation-suitable **for the named profile** (the exclusion is
scoped; a target may still be a valid mutation target in another profile):

- `src/config/reasons-types.ts` — type-only module (base).
- `src/machine/command-help.ts` — static help text projection (base).
- `src/config/profile-types.ts` — type-only module (base).
- `src/machine/topology.ts` — module-init transition table, ignored under `ignoreStatic` (base).
- `src/state/policy-mode.ts` — const tuple/enum only (base).
- `src/state/runtime-lease.ts` — pure Zod schema declarations (base).
- `src/config/reasons-architecture.ts` (base)
- `src/config/reasons-envelope.ts` (base)
- `src/config/reasons-infra.ts` (base)
- `src/config/reasons-mutation.ts` (base)
- `src/config/reasons-precondition.ts` (base)
- `src/config/reasons-proofgraph.ts` (base)
- `src/config/reasons-validation.ts` (base)
- `src/config/reasons-validation-observation.ts` (base)
- `src/config/reasons-validation-review.ts` (base)
- `src/config/reasons-validation-structured.ts` (base)
- `src/presentation/reason-copy.ts` — static copy, 0 valid mutants (human-projection).
- `src/presentation/human-projection.ts` — type-driven composition, 0 valid mutants (human-projection).
- `src/presentation/claim-diagnostic-copy.ts` — static diagnostic copy, 0 valid mutants (human-projection).

Reason-catalog diagnostic (2026-09-17, base regime): all 175 mutants across the
ten catalog files are rejected by the TypeScript checker (CompileError, 0
valid mutants), so the catalog carries no admission evidence under the base
profile. The runtime registry logic in `src/config/reasons.ts` remains a
required mutation target.

### Admission Candidates

A candidate is staged inside a profile for authoritative admission
measurement. It is mutated by its profile but carries no provenance yet: only
a verified profile full run on the freeze commit decides whether it becomes
`required` (immutable admission) or returns to the admission backlog. The
2026-09-21 freeze run admitted five candidates. The durable human-decision
audit intent authority (`src/integration/services/decision-audit-intent.ts`)
is staged inside the base profile; its admission verdict comes from the next
profile full run.

### Running Locally

```bash
npm run mutation    # Runs scripts/stryker-patch.js pre-flight + base profile
node scripts/verify-mutation-admission.mjs --profile base \
  --write-manifest reports/mutation/admission-manifest-base.json

# Re-verify the persisted admission evidence (profile/config/report/commit)
node scripts/verify-mutation-admission.mjs --profile base \
  --manifest reports/mutation/admission-manifest-base.json
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
node scripts/verify-mutation-admission.mjs --profile identity-jwks \
  --write-manifest reports/mutation/identity-jwks/admission-manifest.json
```

The mandates profile runs on pull requests that change mandate surfaces:

```bash
node scripts/stryker-patch.js && npx stryker run stryker.mandates.conf.json
node scripts/verify-mutation-admission.mjs --profile mandates \
  --write-manifest reports/mutation/mandates/admission-manifest.json
```

The human-projection profile is reusable locally but has no dedicated CI
workflow yet; adding one requires a full-profile run that proves every target
meets the per-target threshold first:

```bash
node scripts/stryker-patch.js && npx stryker run stryker.human-projection.conf.json
node scripts/verify-mutation-admission.mjs --profile human-projection \
  --write-manifest reports/mutation/human-projection/admission-manifest.json
```
