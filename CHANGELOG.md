# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Database engine detection in discovery (P14)**: Stack detection now derives database engines from repo evidence (Maven/Gradle dependencies, package.json deps, docker-compose image refs, Testcontainers modules) and surfaces them in `detectedStack.items` as `kind: "database"` with optional version when image tags are unambiguous.
- **Verification Command Planner (P12/P13)**: Added advisory `verificationCandidates` surfaced via `flowguard_status`, derived deterministically from repository evidence with priority: package scripts > Java wrappers (`./mvnw`, `./gradlew`) > detected-tool fallbacks. Commands are planner output only (never auto-executed). Placeholder script filtering now covers conservative bogus command forms across verification scripts (`exit 1`, `echo ... no test specified ...`, `echo TODO`, `echo not implemented`, `TODO`, `not implemented`) to avoid false high-confidence candidates; fallback candidates remain eligible.
- **Tool Error Classification in mandates**: Added explicit error classification (blocked, unexpected exception, malformed response, network/process failure) with differentiated handling. Commands reference central classification instead of duplicating error rules.
- **Rule Conflict Resolution in mandates**: Added explicit priority (Universal Mandates > Slash Command > Profile Rules > Local Style). Profile rules may narrow, never override universal mandates.
- **[EXPERIMENTAL] Headless CLI wrappers**: Added `flowguard run` and `flowguard serve` commands for non-interactive CI/CD integration. These wrap OpenCode's headless modes (`opencode run`, `opencode serve`). **Status**: Experimental — not for production use. Use OpenCode directly for production headless workflows. See [docs/distribution-model.md](./docs/distribution-model.md).
- **[EXPERIMENTAL] ACP compatibility**: Added ACP (Agent Collaboration Protocol) smoke tests for editor/IDE integration. **Status**: Experimental compatibility surface only. Not for production use.
- **Dual-mode logging**: Added file-based logging with mode configuration (`logging.mode: file | ui | both`) defaulting to file. Logs written to `{workspace}/.opencode/logs/flowguard-{YYYY-MM-DD}.log` in JSONL format. Includes configurable retention (`logging.retentionDays: 1-90`, default 7). Logging errors never block governance flow.
- **SpanStatusCode enum**: Replaced magic numbers (1, 2) with explicit `SpanStatusCode.OK` / `SpanStatusCode.ERROR` from @opentelemetry/api for OTEL tracer correctness.
- **OTEL optional dependencies**: Split package.json - `@opentelemetry/api` remains in dependencies, SDK/exporter/instrumentations move to optionalDependencies for minimal footprint.
- **Telemetry race-condition fix**: Added `_initPromise` lock to prevent parallel SDK initialization when multiple `withSpan()` calls race on init. Graceful degradation when OTEL deps missing.
- **Type-aware ESLint**: Extended to `src/integration/` and `src/cli/` for floating promise detection.
- **ESLint no-unused-vars pattern**: Enabled pattern-based unused variable detection (`^_` prefix) across src/ instead of global off.
- **Type-aware ESLint extended**: Added rails/, machine/ to type-aware ESLint coverage.
- **AGENTS v3 enhancements**: Added ASSUMPTION resolution guidance and RED LINES examples.
- **CODEOWNERS**: Added ownership file for critical paths.
- Derived, append-only ticket/plan evidence artifacts under session scope: `artifacts/ticket.v*.{md,json}` and `artifacts/plan.v*.{md,json}`.
- Artifact metadata now records hash linkage to `session-state.json` (`sourceStateHash`) plus content digests for machine verification.
- Derived evidence artifacts now store `sourceStateHash` as provenance (hash of `session-state.json` at materialization time), while runtime verification uses ticket/plan content digests plus `markdownHash` checks to detect drift/tampering.
- **Compliance mapping documentation**: New detailed compliance mappings for MaRisk, BAIT, DORA, and GoBD alongside existing BSI C5 mapping. These documents map FlowGuard capabilities to specific regulatory requirements, demonstrating the building blocks FlowGuard provides for regulated industries (banking, financial services, insurance).
- **Enterprise credibility enhancements**: PRODUCT_IDENTITY.md now includes Self-Review iterations count in Product Facts (SOLO: 2, TEAM/REGULATED: 3), comprehensive compliance mappings list (BSI C5, MaRisk, BAIT, DORA, GoBD), and updated limitations section with clearer language on multi-user coordination and explicit configuration options.
- **Agent mandate v3 guidance set**: Replaced legacy AGENTS mandate layout with a compact cross-LLM v3 structure (priority ladder, task router, single output contract, high-risk extension) and added dedicated guidance docs under `docs/agent-guidance/`.
- **Agent eval scenarios**: Added scenario-based eval suite with pass/fail rubric to validate mandate behavior across trivial, standard, high-risk, release/installer, review, and ambiguity workflows.

### Changed

- SOLO_POLICY now allows 2 self-review iterations (up from 1), enabling single revision after initial review before convergence. Team remains at 3.
- `/hydrate` now enforces a fail-closed discovery contract for new sessions: READY is emitted only when discovery and profile-resolution artifacts are successfully persisted and `discoveryDigest`/`discoverySummary` are non-null.
- Workspace `config.json` is now materialized as a required artifact (install + hydrate self-heal) and doctor reports missing config as an error instead of silently accepting defaults.
- `/hydrate` now fail-closes on invalid existing workspace `config.json` (`WORKSPACE_CONFIG_INVALID`) instead of proceeding with implicit defaults.
- Governance commands now fail-closed when required derived ticket/plan artifacts are missing, malformed, or content/hash-inconsistent with ticket/plan evidence digests (`EVIDENCE_ARTIFACT_MISSING`, `EVIDENCE_ARTIFACT_MISMATCH`).
- State + artifact persistence now performs best-effort rollback semantics (state rollback + cleanup of newly created artifact files) on materialization failures.
- Compliance mapping filename corrected to `docs/marisk-mapping.md` and documentation index now links all compliance mappings and agent-guidance docs.
- AGENTS v3 hard invariants were refined to action-oriented wording with explicit `Red Lines`, while preserving fail-closed and single-authority constraints.
- Review guidance verdict wording is now exactly aligned with root AGENTS contract (`approve` / `changes_requested`) to prevent enum drift.

### Fixed

- OpenCode-style non-UUID session IDs (`ses_...`) are now accepted across binding and audit event schemas, preventing hydration/runtime schema validation failures.
- Integration and E2E tests now run with OpenCode-style session IDs and include regression assertions for hydrate discovery/config contracts.
- Added `src/documentation/__tests__/agents-v3.test.ts` to enforce AGENTS v3 structure, marker rules, high-risk verification policy, guidance link integrity, and rubric presence.
- Eval-suite reference links to OpenAI and Anthropic docs were revalidated and documented for traceability.

## [1.1.0] - 2026-04-17

### Added

- Full 5-category test coverage (HAPPY/BAD/CORNER/EDGE/PERF) for evaluate, workspace, and discovery modules
- Prettier code formatter with `format` and `check:format` scripts
- Dependabot configuration for automated npm and GitHub Actions dependency updates
- OpenTelemetry instrumentation (`src/telemetry/index.ts`) with `withSpan` and `withSpanSync` helpers for distributed tracing
- Conventional-changelog automation for release changelog generation
- Performance benchmarks for evaluateWithEvent (<0.1ms p99), initWorkspace (<50ms), runDiscovery (<100ms)
- Decision receipts in audit trail: successful `/review-decision` now emits `decision:DEC-xxx` events with sequence metadata
- Archive export now includes `decision-receipts.v1.json` derived from the append-only audit chain
- New policy mode `team-ci` for CI auto-approval with explicit CI-context checks
- `/architecture` now auto-generates ADR IDs (`ADR-001`, `ADR-002`, ...) from session-local counter state
- Export redaction support for archive artifacts (`mode: none|basic|strict`, default `basic`, `includeRaw=false`)
- Bounded heuristic `code-surface-analysis` collector (endpoint/auth/data/integration hints with confidence + evidence)
- Coverage gate enforcement in Vitest: global thresholds set to branches/lines/functions/statements >= 80%
- Additional failure-path and edge coverage for archive redaction/read failures, discovery timeout degradation, and stack-derived validation hints (gradle/maven/cargo/go/jest)
- `isConverged()` — shared convergence predicate for review loops, eliminating logic duplication between guards and next-action
- CycloneDX SBOM generation (`release/sbom.cdx.json`) in release pipeline
- GitHub build provenance attestation for release package tarballs
- ESLint TypeScript lint gate (`npm run lint`) in CI
- ESLint hardening: source-only lint scope (`src/**/*.ts`) plus type-aware safety rules on critical governance surfaces (`src/audit`, `src/config`, `src/redaction`, `src/adapters/workspace`)
- Performance test calibration hardening: noisy PERF checks now use percentile benchmarking (p95), centralized budgets for redaction/architecture/filter/query paths, and optional `FLOWGUARD_PERF_BUDGET_FACTOR` for slower developer hardware
- Policy API clarity: added `getPolicyPreset()` as explicit preset lookup surface; `resolvePolicy()` remains as compatibility wrapper
- Release/build packaging integrity check: `npm run check:esm` verifies dist ESM imports after build
- CI workflow linting now runs via `rhysd/actionlint@v1` (blocking) instead of direct docker image invocation
- Added `.github/security-advisories.yml` so private vulnerability reporting policy check is materially configured
- `/review-decision` now enforces four-eyes review with `SOLO_APPROVAL_FORBIDDEN` blocker when `allowSelfApproval=false`
- NextAction system — deterministic next-step guidance on every tool response
- `/review` as standalone flow (READY → REVIEW → REVIEW_COMPLETE) with phase transitions
- `/architecture` command and tool for ADR creation with MADR format validation and self-review loop
- `/continue` handles architecture phase with self-review iteration

### Changed

- CI `npm audit` job is now blocking with `--audit-level=high` (no continue-on-error)
- `deployment-model.md` runtime wording now reflects host-integration truth without hard "same OpenCode/Bun process" claim
- `actionlint` job is now blocking (removed `continue-on-error`)
- Security-policy CI check now fails when private vulnerability reporting config is missing
- Release publication wording in README/installation/distribution/release docs now states tag-driven publication and possible empty Releases page before first tag
- **BREAKING:** `PolicySnapshotSchema` now requires `actorClassification`, `requestedMode`, and `effectiveGateBehavior` fields. Sessions with policy snapshots missing these fields are invalid and will fail on re-hydration. This is a deliberate hard break to restore single-authority snapshot semantics — no backward-compat fallback, no re-derivation from presets.
- `policyFromSnapshot()` now reconstructs policies exclusively from snapshot fields. No preset fallback. The snapshot is the sole authority.
- Terminal phase set (`COMPLETE`, `ARCH_COMPLETE`, `REVIEW_COMPLETE`) is now defined once in `topology.ts` and imported by `commands.ts` and `simple-tools.ts`. Eliminates triple-definition drift risk.
- `DecisionDetail.verdict` in `audit/types.ts` now uses the `ReviewVerdict` type from `state/evidence.ts` instead of an inline string union.
- `WRONG_PHASE` reason message corrected from stale "IMPL_REVIEW" reference to generic "current phase" wording.

### Removed

- Untested performance budgets from test-policy.ts: profileDetect10kMs, reasonLookupMs
- Backward-compat `??` fallback chains for `requestedMode` and `effectiveGateBehavior` in hydrate and plugin modules
- Local terminal phase set definitions in `commands.ts` and `simple-tools.ts`

### Fixed

- LSP errors in config.test.ts from removed budget references
- Type error: PhaseInstructions.length → extractBaseInstructions().length
- Policy drift risk reduced: runtime policy resolution now reconstructs behavior from frozen `policySnapshot` fields
- `team-ci` without CI context now degrades safely to `team` with explicit `ci_context_missing` reason
- Decision receipts now fail-closed on missing reviewer identity (`DECISION_RECEIPT_ACTOR_MISSING`) instead of storing `unknown`
- Removed stale architecture command/test surfaces requiring user-provided ADR IDs
- Archive export is now fail-closed when redaction is enabled and redaction input is invalid
- Archive manifests now record redaction metadata (`redactionMode`, `rawIncluded`, `redactedArtifacts`, `excludedFiles`, `riskFlags`)
- `FOUR_EYES_VIOLATION` → `SELF_APPROVAL_FORBIDDEN` in documentation (matches actual reason code in code)
- Discovery collector count corrected from "5 collectors" to "6 collectors" in product identity

## [1.0.0] - 2026-04-16

### Features

- Three independent flows after `/hydrate`: Ticket (full dev lifecycle), Architecture (ADR creation), Review (compliance report)
- `/architecture` command and tool for ADR creation with MADR format validation and self-review loop
- `/review` as standalone flow (READY → REVIEW → REVIEW_COMPLETE) with phase transitions
- NextAction system — deterministic next-step guidance on every tool response
- MADR artifact writer (`src/integration/artifacts/madr-writer.ts`)
- Architecture phases: ARCHITECTURE, ARCH_REVIEW, ARCH_COMPLETE
- Review phases: REVIEW, REVIEW_COMPLETE
- State machine extended from 8 to 14 phases, 17 events, 10 commands
- `/hydrate` now initializes to READY phase instead of TICKET
- `/ticket` performs READY → TICKET transition before recording task
- `/review-decision` handles ARCH_REVIEW in addition to PLAN_REVIEW and EVIDENCE_REVIEW
- `/continue` handles ARCHITECTURE phase with self-review iteration
- All integration tools emit NextAction footer on every response
- Comprehensive user documentation (`docs/`)
- GitHub Actions CI pipeline (`.github/workflows/ci.yml`)
- Conventional commits validation (`.github/workflows/conventional-commits.yml`)
- Architecture dependency boundary tests
- CONTRIBUTING.md with development guidelines
- **1182 Tests bestanden**

## [0.9.0] - 2026-04-15

### Fixed

- Version aligned between package.json, README.md, and PRODUCT_IDENTITY.md
- Archive finding codes in documentation aligned with implementation
- Test count updated (872 → 884)
- Discovery schema count corrected (12 → 21)

### Changed

- `/archive` clarified as Operational Tool, not Workflow Command
- Documentation updated to reflect correct architecture

### Added

- Architecture dependency boundary tests (22 tests)
- User documentation structure (`docs/`)

## [0.8.0] - 2026-03-01

### Added

- Archive hardening with manifest and verification
- Hash-chained audit trail
- Session archival with integrity verification

## [0.7.0] - 2026-02-01

### Added

- Policy modes (Solo, Team, Regulated)
- Profile system with auto-detection
- Five discovery collectors
- Comprehensive audit subsystem

## [0.6.0] - 2026-01-01

### Added

- Initial release
- 8 workflow phases
- State machine with guards
- Rails orchestrators
- OpenCode integration
