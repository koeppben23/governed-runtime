# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **FG-REL-020 (Issue #129):** Surface partial plugin hook audit persistence failures via `recordAssuranceWithAudit()`. Review-assurance state mutations commit first under the session-state write lock; if the corresponding audit event cannot be persisted, strict paths return a blocked result (`AUDIT_PERSISTENCE_FAILED`) and non-strict paths log a warning. The call sites `blockReviewOutcome`, `runStandardReviewPipeline`, and `handleReviewerFailure` were migrated to use the centralized helper.
- **FG-REL-014 (Issue #123):** [BREAKING] Remove deprecated `resolvePolicy()` export from `@flowguard/core` and config policy barrels. Use `getPolicyPreset()` for static preset lookup (identical behavior), `resolvePolicyWithContext()` for runtime authority, or `resolvePolicyFromSnapshot()` for canonical snapshot-based resolution.

- **FG-QUAL-007 (Issue #219):** [BREAKING] OpenCode tools (`plan`, `implement`, `validate`, `review`, `status`, `hydrate`, `ticket`, `decision`, `abort_session`, `archive`, `architecture`) and `FlowGuardAuditPlugin` are no longer re-exported from `@flowguard/core`. Import them from `@flowguard/core/integration`.
- **FG-QUAL-007 (Issue #219):** [BREAKING] `createTestContext` is no longer exported from `@flowguard/core`. Import it from `@flowguard/core/testing`.

### Added

- **FG-REL-019 (Issue #128):** Serialize session-state write operations via lockfile-based file locking. All known session-state write paths (`writeState()`, `writeStateWithArtifacts()`, `updateReviewAssurance()`) are now serialized through `withSessionWriteLock()` to prevent interleaved writes. `updateReviewAssurance()` additionally gains read-modify-write isolation. Lock acquisition is atomic (O_EXCL lockfile), stale locks from dead processes are auto-recovered via PID liveness check, and lock timeout produces a typed `LOCK_TIMEOUT` error with the blocking PID and recovery path. Tool-layer read-modify-write isolation across individual tool invocations remains follow-up work (documented gap).

- **FG-REL-011 (Issue #120):** Opt-in fail-closed tarball integrity verification via `--checksums-file`. The installer now supports verifying tarball SHA-256 integrity against a `sha256sum`-format checksums file before writing any artifacts. When `--checksums-file` is provided, hash mismatch, missing entries, or duplicate entries in the checksums file produce an explicit error and stop the install before any file is written (fail-closed). Without `--checksums-file`, the installer emits a warning recommending the flag but proceeds as before.
- **`hashFile()`** in `src/shared/hashing.ts` — streaming SHA-256 for byte-level file hashing, canonical authority for binary artifact hashing (separate from `hashText()` for text hashing).

- **Project governance contracts:** Added GitHub issue templates, PR template, project governance documentation, and drift guards requiring clean conventional branches, docs/changelog decisions, risk classification, verification evidence, and high-risk fail-closed coverage.

### Fixed

- **FG-REL-015 (Issue #124):** Removed the dead private `MUTATING` command set from `commands.ts`. Terminal phases now use the equivalent direct `TERMINAL.has(phase)` check; command admissibility behavior is unchanged.

- **FG-QUAL-003 (Issue #215):** Eliminate inconsistent fail-open behavior in `tool.execute.before` host-tool phase gate:
  - Replaced documented fail-open `return` at `plugin.ts:266` with fail-closed `throw buildEnforcementError('SESSION_DIR_NOT_FOUND', ...)` — mutating host tools (bash, write, edit) are now blocked when the FlowGuard session directory is computed but missing from disk
  - Added `SESSION_DIR_NOT_FOUND` reason code in `reasons-precondition.ts` with explicit recovery steps (`/hydrate`)
  - Added `SESSION_DIRECTORY_MISSING` runtime diagnostics via `diagnostics/builders.ts`
  - Added `isFlowGuardVerdictTool()` in `tool-names.ts` to replace ad-hoc 4-way `!==` chain
  - Preserved pre-session path: `getSessionDir()` returning `null` (no fingerprint) still allows host tools
  - Added negative-path tests: missing directory, race-condition directory deletion, non-git worktree pre-session, read-only tool immunity, and `resolveEnforcement` null-safety

## [1.2.0-rc.3] - 2026-05-14

### Changed

- **Test coverage for persistence.ts SSOT:** Contract-level coverage for writeState atomicity (rename retry, writeFile failures), readState schema validation failure modes (20+ specific field violations), appendAuditEvent validation and hash-field preservation, readAuditTrail JSONL parsing edge cases (truncation, whitespace, BOM, non-AuditEvent JSON, large trails), and readConfig precedence (repo→global→default with fail-closed validation of both layers). 60+ tests across `src/adapters/adapters.test.ts` and `src/config/flowguard-config.test.ts`.

- **FG-QUAL-005 (Issue #228):** Add structured runtime diagnostics for blocked FlowGuard actions:
  - Added pure `src/diagnostics/` presentation layer with typed `RuntimeDiagnostics`, stable diagnostic builders, and standalone deterministic failure-card formatting
  - Added machine-readable `diagnostics` payloads to `strictBlockedOutput`, `buildEnforcementError`, `formatRailResult`, and `formatBlocked` without changing existing `code`, `message`, `detail`, `recovery`, or `quickFix` fields
  - Covered the first high-value block codes: `PLUGIN_ENFORCEMENT_UNAVAILABLE`, `HOST_TOOL_PHASE_DENIED`, `HOST_SUBAGENT_TASK_REQUIRED`, `SUBAGENT_EVIDENCE_MISSING`, `SUBAGENT_EVIDENCE_REUSED`, and `STRICT_REVIEW_ORCHESTRATION_FAILED`
  - Enriched phase-gate and host-task evidence failures with non-authoritative context for root-cause explanation
  - No command admissibility, policy, evidence validation, state transition, gate, or fail-closed semantics changed; diagnostics remain presentation-only

- **FG-QUAL-004 (Issue #226):** Close logging gaps across I/O-critical error paths:
  - `persistence.ts`: added `getAdapterLogger().error()` before throw in `readReport`, `readAuditTrail`, `readDiscovery`; added try/catch logging in `appendAuditEvent`; added non-ENOENT diagnostic in `stateExists`
  - `plugin.ts`: added `console.warn` for silently swallowed fingerprint resolution failure
  - `plugin-logging.ts`: added `console.warn` for silent config fallback to defaults
  - `plugin-policy.ts`: distinguish EACCES/EPERM from ENOENT/ENOTDIR, log abnormal access errors via `log.warn`
  - `cli/run.ts`: added `getAdapterLogger()` calls in `executeOpenCode` error, `run` failure, `serve` startup failure paths (effective when CLI logger context is active; noop-safe otherwise)
  - `cli/install-command.ts`, `cli/uninstall-command.ts`: added `getAdapterLogger().error()` in outer catch blocks
  - No control-flow, policy, state, or output JSON semantics changed; added diagnostics/logging only

- **FG-QUAL-003 (Issue #224):** Move `plugin-review-state.ts` and `plugin-review-audit.ts` into review bounded context:
  - Renamed `plugin-review-state.ts` → `review/obligation-state.ts`, `plugin-review-audit.ts` → `review/audit-events.ts`
  - Updated barrel `review/index.ts` with `updateObligation`, `blockObligation`, `appendReviewAuditEvent` exports
  - Documented `adapters/persistence` as allowed infrastructure dependency for `review/` context
  - Updated 3 production consumers and 8 test files (vi.mock paths + direct imports)
  - Added 5 architecture boundary assertions proving moved files respect layer rules
  - Zero runtime behavior changes, zero schema changes, zero public API changes

- **FG-QUAL-002 (Issue #214):** Extract review subsystem into bounded context `integration/review/`:
  - Moved 11 review modules + 6 test files into `src/integration/review/` with `enforcement/` sub-directory
  - Created barrel exports for clean public API surface
  - Updated all 20+ consumer import paths and architecture boundary tests
  - Zero runtime behavior changes, zero schema changes, zero public API changes

- **FG-QUAL-001 (Issue #213):** Decompose 590-line god function `runReviewOrchestration` into single-responsibility helpers:
  - Extracted shared strict enforcement, content analysis, and standard review pipeline helpers
  - Introduced typed options interfaces replacing 6-parameter positional signatures
  - `runReviewOrchestration` reduced to ~30 lines thin dispatcher
  - Zero public API changes, zero behavioral changes, all 121 orchestrator tests pass unmodified
- **FG-REL-050 (Issue #201):** Baseline quick wins — removed unused `eslint-disable` directive, consolidated `createLifecycleEvent`, `finalizeDecision`, `executeFormatFreePrompt`, `ensureMetaJson`, and `createPlanArtifact` from positional parameters to typed input objects; eliminated 7 `max-params`/`max-lines`/`unused-disable` warnings
- **FG-REL-049 (Issue #200):** Split `normalizePolicySnapshotWithMeta` into auditable typed field normalizers — extracted `normalizeMode`, `normalizeHash`, `normalizeCoreFields`, `normalizePolicyFields`, `normalizeActorAssurance`, `normalizeIdpMode`, `normalizeActorClassification`, `normalizeAudit`, and `extractProvenanceFields` as private helpers; wrapper reduced to ~60 lines with complexity under 12 — zero public contract changes
- **FG-REL-047 (Issue #198):** Start tool execute decomposition with status-tool extraction, hydrate policy resolution extraction, and local plan/implement/architecture phase extraction; no JSON output changes.
- **FG-REL-048 (Issue #199):** Replace smoke-only architecture boundary checks with robust import boundary enforcement:
  - Removed "smoke test" disclaimer from dependency-rules.test.ts — now treated as authoritative boundary enforcement
  - Registered `presentation/` layer in FF_MODULES and added deny-list rule (forbids imports from integration, rails, cli, audit, archive)
  - Added pure-function negative fixture tests proving violations in state and presentation layers are detected
  - Integrated CLI facade integrity check from architecture-boundary.test.ts (facade imports commands; commands don't circular-import facade)
  - Added explicit directory existence assertions for all 13 core layer directories
  - Deleted `architecture-boundary.test.ts` (all checks now in dependency-rules.test.ts)
  - Updated `test:architecture` script to use directory glob only
  - Zero runtime changes, zero production code changes
- **FG-REL-046 (Issue #197):** Decompose plugin orchestration and hook handlers to reduce function sizes:
  - `plugin-audit.ts`: extracted `resolveAuditContext` (fingerprint + session + policy + parse), `emitDecisionReceipt` (80-line decision event block), and `maybeCompleteAndArchive` (completion detection + auto-archive) — `runAudit` reduced from 299 to ~135 lines; prevHash threaded explicitly in/out
  - `plugin.ts`: extracted `handleHostTaskEvidence` (81-line host-task evidence binding block) into new `plugin-task-evidence.ts`; after hook reduced by 81 lines
  - `plugin-orchestrator.ts`: extracted `validateSessionContext` (session validation preamble), `handleHostTaskPolicy` (P35 invocation policy gate), and `buildToolPrompt` (3-way prompt selector with typed params object) — `runReviewOrchestration` reduced from 716 to ~520 lines
  - `emitDecisionReceipt` and `buildToolPrompt` use typed params objects instead of wide positional parameter lists
  - Zero enforcement semantic changes, no new error codes, no recovery text changes
- **FG-REL-044 (Issue #194):** Eliminate remaining `any` types in production and test code:
  - Production: removed 2 `any` + 2 `eslint-disable` from `plugin-logging.ts` by introducing typed `PluginLogClient`/`PluginLogMessage` interfaces matching the OpenCode SDK log shape; kept 1 `any` in `helpers.ts` `execute(args: any)` with improved Zod runtime validation justification
  - `enforceBeforeVerdict` in `review-enforcement.ts`: narrowed `sessionState` parameter from `SessionState | null` to `{ reviewAssurance?: SessionState['reviewAssurance'] | null } | null` — function only accesses `reviewAssurance?.obligations`, no longer accepts arbitrary `Partial<SessionState>`
  - `status.test.ts`: 15 `(state.policySnapshot as any).selfReview = {...}` mutations replaced with typed spread using the already-typed `PolicySnapshot.selfReview` field
  - `review-enforcement-session.test.ts`: 17 `as any` casts removed by narrowing `enforceBeforeVerdict` to the review-assurance carrier shape
  - `audit-completeness.test.ts`: 8 `as any` casts removed — tested phases already members of `Phase` enum
  - Zero runtime behavior changes, zero schema changes
- **FG-REL-043 (Issue #193):** Add barrel exports to `src/adapters/workspace/` and `src/presentation/`:
  - `adapters/workspace/index.ts` extended with `materializeEvidenceArtifacts`, `materializeReviewCardArtifact`, `verifyEvidenceArtifacts` re-exports from `evidence-artifacts.js`
  - New `presentation/index.ts` barrel exports 5 public presentation symbols: `PHASE_LABELS`, `buildProductNextAction`, `buildPlanReviewCard`, `buildArchitectureReviewCard`, `buildReviewReportCard` (explicit named exports only, no `export *`)
  - 4 integration files updated from deep imports to barrel imports (`helpers.ts`, `plan.ts`, `architecture.ts`, `simple-tools.ts`)
  - 37 barrel export regression tests (HAPPY/BAD/CORNER/EDGE/SMOKE/E2E) proving no API expansion and correct import paths
  - No new public API surface, no runtime behavior changes
- **FG-REL-017 (Issue #126):** Split the CLI installer monolith into cohesive command authorities while preserving the executable `src/cli/install.ts` facade:
  - New `install-command.ts`, `uninstall-command.ts`, and `doctor-command.ts` own install, uninstall, and doctor behavior respectively
  - `install.ts` remains the public CLI/bin entrypoint with compatibility re-exports, argument parsing, output formatting, and `main()` dispatch
  - Shared FlowGuard tarball filename authority moved to `install-helpers.ts` so install validation and uninstall ownership checks use the same regex
  - Added an architecture smoke check to prevent the command implementations from drifting back into the facade
- **FG-REL-012 (Issue #121):** Split `src/state/evidence.ts` (823 LOC, 22 schemas, 10+ concerns) into 12 focused single-authority modules:
  - `evidence-primitives.ts` — foundational enums, scalars, assurance helper (CheckId, ReviewVerdict, RevisionDelta, LoopVerdict, etc.)
  - `evidence-error.ts` — fail-closed ErrorInfo schema
  - `evidence-ticket.ts` — TicketEvidence with input origin and external references
  - `evidence-binding.ts` — workspace BindingInfo with fingerprint validation
  - `evidence-validation.ts` — ValidationResult with evidence metadata
  - `evidence-impl.ts` — ImplEvidence and ImplReviewResult (digest-stop loop)
  - `evidence-plan.ts` — PlanEvidence, PlanRecord with version history, SelfReviewLoop
  - `evidence-architecture.ts` — ArchitectureDecision, ADR section validation, MADR helpers
  - `evidence-review.ts` — review findings, obligations, invocation evidence, assurance state, completeness report, review decision, standalone ReviewReport
  - `evidence-identity.ts` — DecisionIdentity, ActorInfo, ActorVerificationMeta, assurance-backed schemas
  - `evidence-policy.ts` — frozen PolicySnapshotSchema with governance-critical fields
  - `evidence-audit.ts` — tamper-evident AuditEvent with hash-chain linking
  - `evidence.ts` reduced to a 12-module facade with `export *` / `export type *` re-exports preserving all existing import paths
  - 121 new per-module tests (HAPPY, BAD, CORNER, EDGE) in `evidence-split.test.ts` proving independent module correctness
  - Zero consumer file changes — 49 files across `rails/`, `integration/`, `audit/`, `config/`, `adapters/` import unchanged from `state/evidence.js`
  - Zero schema semantics changes, zero runtime behavior changes
- **FG-REL-016 (Issue #125):** Split `src/config/policy.ts` into focused policy implementation modules while preserving the stable `config/policy.js` facade:
  - New `policy-errors.ts`, `policy-presets.ts`, `policy-ci.ts`, `policy-central.ts`, and `policy-resolver.ts` modules separate error taxonomy, preset authority, CI detection, central policy validation, and runtime/hydrate resolution
  - `policy.ts` is now a compatibility facade with the same existing public exports, avoiding public API expansion
  - `policy-snapshot.ts` imports types/defaults from lower policy modules to avoid facade cycles while keeping snapshot authority separate
  - `resolvePolicyForHydrate` behavior is preserved and decomposed below the existing policy-specific lint complexity warnings
- **FG-REL-041 (Issue #191):** Replace direct `process.env` mutation in tests with scoped `withTestEnv` helper:
  - New `withTestEnv(overrides)` function in `test-helpers.ts` with atomic save/restore and idempotent cleanup
  - 22 test files migrated from manual save/restore patterns to `withTestEnv`
  - Fixed leaky env mutation in `telemetry/index.test.ts` (OTEL_EXPORTER_OTLP_ENDPOINT deleted without restore)
  - Fixed leaky env mutation in `workspace.test.ts` PERF block (OPENCODE_CONFIG_DIR set without restore)
  - 17 tests for the helper itself (HAPPY 4, BAD 3, CORNER 3, EDGE 3, SMOKE 4)
- **FG-REL-040 (Issue #190):** Add typed error code unions to all 8 custom error classes:
  - `PersistenceErrorCode` (4 codes): `READ_FAILED`, `WRITE_FAILED`, `PARSE_FAILED`, `SCHEMA_VALIDATION_FAILED`
  - `GitErrorCode` (4 codes): `GIT_NOT_FOUND`, `GIT_TIMEOUT`, `GIT_COMMAND_FAILED`, `NOT_GIT_REPO`
  - `WorkspaceErrorCode` (7 codes): `INVALID_FINGERPRINT`, `INVALID_SESSION_ID`, `INIT_FAILED`, `WRITE_FAILED`, `READ_FAILED`, `WORKSPACE_MISMATCH`, `ARCHIVE_FAILED`
  - `EvidenceArtifactErrorCode` (3 codes): `EVIDENCE_ARTIFACT_MISSING`, `EVIDENCE_ARTIFACT_MISMATCH`, `EVIDENCE_ARTIFACT_IMMUTABLE`
  - `BindingErrorCode` (4 codes): `MISSING_SESSION_ID`, `NO_WORKTREE`, `NOT_GIT_REPO`, `WORKTREE_MISMATCH`
  - `PolicyConfigurationErrorCode` (9 codes): all central-policy and mode validation codes
  - `ActorClaimErrorCode` (5 codes) and `ActorIdentityErrorCode` (4 codes) extracted from inline unions to named exports
  - Compile-time safety tests proving invalid codes are rejected (`@ts-expect-error`)
- **FG-REL-038 (Issue #188):** Split `review-orchestrator.ts` (1,490 LOC) and `review-enforcement.ts` (1,217 LOC) into focused single-responsibility modules:
  - `review-findings-schema.ts` — JSON Schema definition for ReviewFindings
  - `review-text-extraction.ts` — Multi-strategy JSON extraction from text
  - `review-prompt-builders.ts` — All prompt builders (plan, impl, arch, content) + profile rules
  - `review-agent-resolution.ts` — Agent registry probe, cache, model capability detection
  - `review-enforcement-types.ts` — Types, interfaces, constants (universal coupling point)
  - `review-enforcement-extraction.ts` — Pure parsing/extraction helpers (content meta, findings, session ID, JSON blocks)
  - `review-evidence-binding.ts` — Host-task evidence binding (buildHostTaskEvidence)
  - `review-orchestrator.ts` (residual) — SDK invocation, output mutation, review detection
  - `review-enforcement.ts` (residual) — State factory, hook handlers, L1-L4 enforcement
  - All 13 consumer files migrated to direct imports (no re-exports, no facades)
- **FG-REL-039 (Issue #189):** Split the 5 largest test files (>2000 LOC each) into per-concern suites:
  - `config/config.test.ts` (2691 LOC) → `policy.test.ts` + `profile.test.ts` + `reasons.test.ts`
  - `audit/audit.test.ts` (2482 LOC) → 5 per-module files + `audit-test-helpers.ts`
  - `review-orchestrator-agent-resolution.test.ts` (2788 LOC) → 4 per-concern files + `review-orchestrator-test-helpers.ts`
  - `review-enforcement.test.ts` (3223 LOC) → 4 per-concern files + `review-enforcement-test-helpers.ts`
  - `plugin-host-task-diagnostics.test.ts` (2670 LOC) → 3 per-concern files + `plugin-host-task-diagnostics-helpers.ts`
  - All 921 tests preserved across 19 new files (no test removal, no file >1500 LOC)
- **FG-REL-042 (Issue #192):** Add vitest workspace for native unit/integration/smoke test separation:
  - New `vitest.workspace.ts` defining 3 projects: `unit` (src/**/\*.test.ts, 15s timeout), `integration` (src/integration/**/\*.test.ts, 60s timeout), `smoke` (build-dependent CLI tests, 120s timeout)
  - Per-project coverage thresholds: unit 80/80/80/80, integration 70/70/70/70, smoke none
  - All `package.json` test scripts migrated from `--exclude` hacks to native `--project` flags
  - CI `test` job simplified from raw `npx vitest run --exclude ...` to `npm test`
  - `npm test` = unit + integration (default fast CI feedback); `npm run test:smoke` = opt-in build-dependent tests
  - Root `vitest.config.ts` stripped to coverage-only fallback (project config in workspace)

### Added

- Clean Code D: IP validation extracted from review.ts to adapters/ip-validation.ts. PACKAGE_FILES and CONFIG_FILES lifted from function-scoped to module-level const in git.ts. Dynamic imports replaced with static imports in archive.ts and plugin-policy.ts.
- Clean Code D: `resolveHostTaskEffectiveFindings` helper in review-validation.ts replaces 3× ~68-line duplicated host-task resolution blocks in plan.ts, implement.ts, and architecture.ts. All existing behavior (host_task_required evidence resolution, reviewerUnavailable fallback, SDK path validation) preserved 1:1.
- Clean Code A: canonical constants for `FINGERPRINT_PATTERN`, `REVIEWER_SUBAGENT_TYPE`, and `REVIEW_REPORT_SCHEMA_ID` centralized in `shared/flowguard-identifiers.ts`. All ~55 hardcoded `'flowguard-reviewer'` code strings replaced with the canonical constant. Ticket external-reference table data-driven from structured constant. Schema-level `FINGERPRINT_PATTERN` shared between `state/evidence.ts` and `archive/types.ts`.

- Clean Code B: 3 telemetry catch blocks now log warnings via adapter logger instead of silently swallowing errors. `parseIPv4` rejects hex-formatted octets via decimal-only regex. Tarball filename matching tightened to version-pattern regex (digest verification deferred).

- Narrowed `OrchestratorDeps.client` from `unknown` to `OrchestratorClient`. Removed redundant casts inside `plugin-orchestrator.ts`. Removed `BlockedResult<_T>` phantom generic parameter and `_artifactType?: never` phantom field. `AnyObj` alias in `install-helpers.ts` changed to `Record<string, unknown>`.

- 39 new tests in `install-templates.test.ts` covering reviewCard presentation mandate (HAPPY×12: Presentation section + verbatim mandate + Done-when for all 4 commands, BAD×8: anti-summarize + anti-truncate for all 4 commands, CORNER×3: non-reviewCard commands excluded + ordering constraints, EDGE×6: mandatory output declaration + 3-bullet structure + review-loop cross-reference, E2E SMOKE×4: complete contract verification per command).

- ~30 new tests in `review-enforcement.test.ts` covering BUG-21 null-verdict tolerance (before-hook null stripping, value-based mode detection, sessionState fallback, after-hook null handling, E2E smoke with DeepSeek R1 payload shape).
- ~6 new tests in `tools-execute-planning.test.ts` covering BUG-21 plan tool null mode detection (null selfReviewVerdict treated as Mode A, null reviewFindings treated as Mode A).
- ~3 new tests in `tools-execute-execution.test.ts` covering BUG-21 implement tool null mode detection.
- ~3 new tests in `tools/architecture-tool.test.ts` covering BUG-21 architecture tool null mode detection.

- 16 new tests in `plugin-host-task-diagnostics.test.ts` covering BUG-20 attestation-free fallback binding (HAPPY×3, BAD×3, EDGE×3, CORNER×2, REGRESSION×3, SMOKE×2, E2E×2). Includes exact reproduction of the 2026-05-11 production log failure scenario.

- 6 new tests in `evidence-first-resolution.test.ts` covering BUG-19 reviewer unavailability (HAPPY×2, BAD/EDGE×2 strict blocks, EDGE×1 reviewMode='self', REGRESSION×1).
- 1 new test in `plugin-orchestrator-bug16.test.ts` covering BUG-19 fallback instruction in next field.

- 8 new tests in `evidence-first-resolution.test.ts` covering BUG-17 plan and implement evidence-first patterns (HAPPY×2, BAD×2, EDGE×2, REGRESSION×2).
- 3 new tests in `architecture-tool.test.ts` covering BUG-17 architecture evidence-first behavior (EDGE×2 for invalid-findings-ignored, REGRESSION×1 for SDK path).
- 6 new tests in `plugin-orchestrator-bug16.test.ts` covering BUG-16 context preservation (HAPPY×2, EDGE×2, SMOKE×2).

- `capturedRawFindings` optional field on `ReviewInvocationEvidence` Zod schema — stores the reviewer's complete raw findings object captured by the plugin hook.
- `resolveHostTaskFindings()` and `ResolvedHostTaskFindings` interface exported from `review-validation.ts` — resolves findings from invocation evidence for `host_task_required` mode.
- `capturedRawFindings` parameter on `buildInvocationEvidence()` in `review-assurance.ts`.
- 14 new tests in `review-validation.test.ts` covering `resolveHostTaskFindings` (HAPPY×2, BAD×5, EDGE×5, CORNER×2).
- 5 new tests in `review-assurance.test.ts` covering `capturedRawFindings` field (HAPPY×2, EDGE×2, CORNER×1).
- 6 new tests in `plugin-host-task-diagnostics.test.ts` covering E2E evidence-based findings resolution (E2E×3, BAD×1, SMOKE×2).
- 6 new tests in `architecture-tool.test.ts` covering tool-level evidence resolve (HAPPY×1, BAD×2, EDGE×2, CORNER×1).

- `capturedVerdict` optional field on `ReviewInvocationEvidence` Zod schema — stores the reviewer's authoritative verdict captured by the plugin hook.
- `capturedVerdict` parameter on `buildInvocationEvidence()` in `review-assurance.ts`.
- 5 new tests in `review-assurance.test.ts` covering `capturedVerdict` field (HAPPY×3, EDGE×2: Zod round-trip, backward compat).
- 6 new tests in `review-validation.test.ts` covering BUG-15 verdict-based validation (HAPPY×2, BAD×2, CORNER×1, EDGE×1, REGRESSION×1).
- 7 new tests in `plugin-host-task-diagnostics.test.ts` covering `capturedVerdict` evidence creation and E2E revision loop (HAPPY×2, EDGE×1, SMOKE×1, E2E×3: verdict match, verdict tamper, hash-mismatch-with-verdict-match).

- `TaskToolContext` interface, `resolveSessionIdFromMetadata()`, and `injectSessionIdIntoOutput()` exported from `review-enforcement.ts` for tiered session ID resolution.
- `getToolMetadata()` and `getToolCallID()` exported from `plugin-helpers.ts` for hook metadata extraction.
- 37 new tests in `review-enforcement.test.ts` covering `resolveSessionIdFromMetadata` (12 tests: HAPPY, BAD, CORNER, EDGE), `injectSessionIdIntoOutput` (13 tests: HAPPY, BAD, CORNER, EDGE, SMOKE), and `onTaskToolAfter` tiered session ID resolution (12 tests: HAPPY, BAD, CORNER, EDGE, E2E).
- 20 new tests in `plugin-helpers.test.ts` covering `getToolMetadata` and `getToolCallID` (HAPPY, BAD, CORNER, EDGE).
- 17 new integration tests in `plugin-host-task-diagnostics.test.ts` covering BUG-14 tiered session ID resolution with metadata/callID (HAPPY×3, BAD×3, CORNER×4, EDGE×3, SMOKE×1, E2E×3).
- `HostTaskBindResult` and `HostTaskBindOutcome` types exported from `review-enforcement.ts` for structured host-task binding diagnostics.
- `validateReviewUrl()` exported from `rails/review.ts` — pure URL validation function for SSRF mitigation with scheme allowlist and private IP blocking.
- 9 new tests in `plugin-orchestrator-arch-ssot.test.ts` covering BUG-12 architecture SSOT enforcement (HAPPY×2, BAD×2, CORNER×2, EDGE×1, SMOKE×2).
- 24 new tests in `review.test.ts` covering BUG-13 URL validation (HAPPY×3, BAD×15, CORNER×3, EDGE×3) — scheme blocking, private IP blocking, malformed URLs, and boundary public IPs.
- 18 new tests in `plugin-host-task-diagnostics.test.ts` covering all 9 `bindOutcome` values (HAPPY, BAD, CORNER, EDGE, SMOKE, E2E).

- `REVIEWER_INVOCATION_EXHAUSTED` reason code (adapter category) for blocking obligations after all subagent retry attempts are exhausted.
- 10 new tests in `plugin-orchestrator-exhaustion.test.ts` covering BUG-07 exhaustion blocking (HAPPY, BAD, CORNER, EDGE, SMOKE, E2E).
- 8 new tests in `plugin-orchestrator-plan-ssot.test.ts` covering BUG-09 plan text SSOT enforcement (HAPPY, BAD, CORNER, EDGE, SMOKE).
- `HOST_TOOL_PHASE_DENIED` reason code (admissibility category) for phase-gated host tool blocks.
- `SUBAGENT_TYPE_UNAUTHORIZED` reason code (precondition category) for unauthorized subagent type detection.
- `phase-tool-gate.ts` module with `isMutatingHostTool()` and `isHostToolAllowedInPhase()` pure functions.
- Info-level hook entry logging for `tool.execute.before` and `tool.execute.after` in `plugin.ts` — a session with 10 tool calls now produces ~20 info-level log entries instead of ~4 (BUG-05).
- 80 new tests in `phase-tool-gate.test.ts` covering `isMutatingHostTool` (11 tests) and `isHostToolAllowedInPhase` (69 tests: HAPPY, BAD, CORNER, EDGE, SMOKE, E2E matrix).
- 14 new integration tests in `plugin.test.ts`: 7 for BUG-08 subagent type authorization, 7 for BUG-03 phase gate wiring.
- `SESSION_ERROR` reason code registered in the default reason registry (adapter category) for audit trail persistence of host runtime session errors.
- 12 new tests in `plugin-events.test.ts` covering error detail extraction (5 tests: happy, corner, edge) and audit trail emission (7 tests: happy, bad, corner, edge).

- **Comprehensive structured logging across all adapter layers**: Adapter modules (persistence, git, archive, init, evidence-artifacts, gh-cli, actor) now emit structured logs for all critical failure paths and silent fallbacks. Logging is injected via `AsyncLocalStorage`-scoped DI — adapter functions call `getAdapterLogger()` and receive the plugin or CLI logger for the current execution scope.
- **Console logging sink** (`console-sink.ts`): New sink writes formatted structured log entries to stderr. Configurable via `logging.mode: 'console'` or `'file+console'`.
- **`--log-mode` CLI flag**: `flowguard install|doctor|uninstall --log-mode console|file|file+console` controls CLI logging output. Adapter logger is reset after each CLI command (`try/finally`).
- **Identity log redaction** (`redact.ts`): Identity and JWT/JWKS error logs sanitize sensitive fields — token paths redacted to basename, JWKS URIs to hostname, issuers to SHA-256 prefix, and error messages stripped of absolute paths and URLs.
- **warnOnce deduplication**: Repeated adapter fallback warnings (e.g. git branch/commit/remote resolution failures) are deduplicated per ALS scope. `git-warnonce.test.ts` proves real callsite deduplication.
- **Logging coverage proofs**: Comprehensive test suite (`coverage-proof.test.ts`, `adapter-real-sink.test.ts`, `git-warnonce.test.ts`) proving adapter failures write to file sinks, git fallbacks log warnings, two ALS scopes do not leak, identity errors are properly redacted, and `--log-mode=file` produces real `.log` files.
- **Architecture diagram (#135)**: Layered Mermaid architecture diagram at `docs/architecture/architecture-diagram.md`.
- **Desktop task-hardening warning (#107)**: `flowguard doctor` emits a `warn` when a desktop-owned config lacks FlowGuard reviewer task hardening.
- **Install test decomposition**: Split `install.test.ts` (2196 LOC) into 6 focused test files.
- **Installer auto-install (P11)**: `flowguard install` now automatically runs `bun install` or `npm install` after writing files.
- **Rail unit tests for 6 untested rails (P10b)**: 37 rail unit tests for `abort`, `ticket`, `plan`, `validate`, `implement`, and `continue` rails.
- **Strict Independent Review Hardening**: Tightened strict independent review to require OpenCode SDK `json_schema` structured output, mandatory reviewer attestation, one-use mandate-bound invocation evidence, and `reviewMode: "subagent"` in strict orchestrated paths.
- **Independent Review Governance**: Fully implemented agent-orchestrated independent review with deterministic plugin-initiated subagent invocation, 4-level plugin enforcement, and 1:1 obligation matching.
- **IdP-Verified Actor Identity**: Added static-key JWT verification plus JWKS key resolution (`identityProvider.mode: 'static' | 'jwks'`). RS256 and ES256 support via `jose`. Typed IdP error taxonomy with 23 error codes.
- **Actor Assurance Architecture**: Three-tier assurance model (`best_effort`, `claim_validated`, `idp_verified`) with source/assurance separation.
- **Visible `/status` orientation command**: Added user-facing `/status` command with focused detail flags.
- **Non-interactive fail-closed mandate clarity**: Headless/non-interactive paths now require returning `BLOCKED` with exact missing inputs.
- **Validated Actor Claim Bridge**: Local actor claim support via `FLOWGUARD_ACTOR_CLAIMS_PATH`.
- **Config as Runtime Authority**: Profile resolution follows explicit > config > detected > baseline priority.
- **Runtime Policy Mode Unification**: Unified fallback for all runtime surfaces (`state > config > solo`).
- **Actor Identity Bridge**: Minimal best-effort operator identity for audit attribution via `resolveActor()`.
- **Enterprise readiness**: Consolidated control narrative for enterprise/security/procurement review.
- **Central policy authority baseline**: Central policy distribution model via `FLOWGUARD_POLICY_PATH`.
- **Database/ecosystem detection in discovery**: Stack detection now derives database engines, Python/Rust/Go ecosystem signals.
- **Verification output contract hardening**: `/plan`, `/implement`, and `/review` output contracts now require visible verification sections.
- **Module-scoped stack detection**: Added scoped stack facts for monorepos.
- **Verification Command Planner**: Advisory `verificationCandidates` surfaced via `flowguard_status`.
- **Tool Error Classification in mandates**: Explicit error classification with differentiated handling.
- **Rule Conflict Resolution in mandates**: Explicit priority (Universal Mandates > Slash Command > Profile Rules > Local Style).
- **[EXPERIMENTAL] Headless CLI wrappers**: `flowguard run` and `flowguard serve` commands for non-interactive CI/CD integration.
- **[EXPERIMENTAL] ACP compatibility**: ACP smoke tests for editor/IDE integration.
- **Dual-mode logging**: File-based logging with mode configuration (`logging.mode: file | ui | both`). JSONL format with configurable retention.
- **OTEL optional dependencies**: SDK/exporter/instrumentations moved to optionalDependencies.
- **Type-aware ESLint**: Extended to `src/integration/`, `src/cli/`, `rails/`, `machine/`.
- **AGENTS v3 enhancements**: ASSUMPTION resolution guidance and RED LINES examples.
- **Derived evidence artifacts**: Append-only ticket/plan evidence artifacts under session scope with hash linkage to `session-state.json`.
- **Compliance mapping documentation**: New detailed compliance mappings for MaRisk, BAIT, DORA, GoBD, BSI C5.
- **Product command facade**: User-friendly product slash-command templates.
- **Policy Snapshot Authority**: Centralized policy snapshot lifecycle with dedicated authority functions.
- **Policy-Aware Actor Resolution**: Decision paths resolve actor identity with full policy snapshot context.
- **Governance Field Completeness**: Hydration policy input forwards identity provider configuration through to the policy snapshot.
- **GitHub Actions supply-chain pinning**: CI workflows pin external GitHub Actions to immutable commit SHAs.
- **Plan Review Card**: Structured markdown card embedded when self-review converges.
- **Installer workspace initialization fix**: Installer uses `ensureWorkspace()` — same SSOT path as runtime.
- **Test workspace safety guard**: `FLOWGUARD_REQUIRE_TEST_CONFIG_DIR` guard blocks workspace ops without isolated temp directory.
- **TypeDoc API Reference**: Browsable TypeScript API documentation generated via `npm run docs`.
- **Governance test hardening**: Deterministic coverage for actor assurance, policy snapshot regression, state machine invariants, audit/archive tampering.
- **StrykerJS mutation testing**: Mutation testing for security-critical governance code.
- **External references for `/ticket` and `/review`**: Structured external references with audit provenance.
- **Agent mandate v3 guidance set**: Compact cross-LLM v3 structure with dedicated guidance docs.
- **Agent eval scenarios**: Scenario-based eval suite with pass/fail rubric.

- `src/templates/commands/plan.ts`: Added `## Presentation` section (3 bullets: verbatim display mandate, content description, mandatory output declaration). Added `reviewCard` to Done-when. Replaced inline sub-bullet ("Present any reviewCard field in full") with cross-reference to Presentation section.
- `src/templates/commands/implement.ts`: Added `## Presentation` section (same 3-bullet pattern). Added `reviewCard` to Done-when. Replaced weak "Report the final status" with cross-reference to Presentation section.
- `src/templates/commands/architecture.ts`: Strengthened existing `## Presentation` section with "never summarize, truncate, or omit" prohibition. Added `reviewCard` to Done-when. Added cross-reference from review loop step. Content description updated to match pattern.
- `src/templates/commands/review.ts`: Refactored inline step 7 ("Present the report:") into dedicated `## Presentation` section with same 3-bullet pattern. Added `reviewCard` to Done-when. Content description updated for compliance context.

- `src/integration/plugin.ts`: Before-hook now strips keys with `null` values from tool args object before passing to `enforceBeforeVerdict`. This normalizes LLM behavior (DeepSeek R1 sends explicit nulls for optional fields) without mutating the original args reference used downstream.
- `src/integration/review-enforcement.ts`: Mode detection in `enforceBeforeVerdict` and after-hook uses value-based checks (`typeof === 'string' && .length > 0`) instead of `in` operator. SessionState access wrapped in existence guard — missing sessionState (fresh session after `/ticket`) no longer triggers `REVIEW_ASSURANCE_STATE_UNAVAILABLE`.
- `src/integration/tools/plan.ts`, `implement.ts`, `architecture.ts`: Mode detection in `execute()` uses `typeof` + length checks instead of `!== undefined` comparisons, making them null-safe.

- `src/integration/review-enforcement.ts`: `buildHostTaskEvidence` now validates `attestation.toolObligationId` as a UUID before using attestation-based matching. Invalid/missing attestation triggers tool-based fallback. Field mismatch checks for attestation-specific fields (`mandateDigest`, `criteriaVersion`, `reviewedBy`) only run when valid attestation is present. Diagnostic object now includes `bindingMode: 'attestation' | 'tool_fallback'` for observability.
- `HostTaskBindOutcome` type: removed `'no_attestation'` variant (no longer produced).

- `plan.ts`, `implement.ts`, `architecture.ts`: Added `reviewerUnavailable: z.boolean().optional()` to tool args schema. Added fallback path: when `reviewerUnavailable === true` in strict mode → BLOCKED with `REVIEWER_UNAVAILABLE_STRICT`; in non-strict → synthetic self-review findings with `reviewMode: 'self'`.
- `plugin-orchestrator.ts`: `buildHostTaskPolicyOutput` next field now includes fallback instruction for reviewer unavailability ("If Task tool cannot spawn reviewer, submit selfReviewVerdict with reviewerUnavailable: true").
- `src/state/evidence.ts`: `ReviewFindings.reviewMode` extended from `z.literal('subagent')` to `z.enum(['subagent', 'self'])`.
- `src/config/reasons-precondition.ts`: New reason code `REVIEWER_UNAVAILABLE_STRICT` registered (PRECONDITION category).
- `src/templates/commands/plan.ts`, `implement.ts`, `architecture.ts`: Added fallback instruction for reviewer unavailability to template content.

- `plan.ts`, `implement.ts`, `architecture.ts` (Mode B paths): restructured findings resolution to evidence-first pattern. In `host_task_required` mode, `args.reviewFindings` is ignored with a warn log; `resolveHostTaskFindings()` is called unconditionally. `else if (args.reviewFindings)` branch handles SDK path with full `validateReviewFindings` validation.
- `plugin-orchestrator.ts`: `buildHostTaskPolicyOutput` imports `extractContentMeta` from `review-enforcement.ts` and preserves original iteration/planVersion in the mutated `next` field. Adds "must NOT call FlowGuard tools" instruction for the reviewer subagent.
- `src/templates/commands/plan.ts`, `implement.ts`, `architecture.ts`: Updated to clarify that in host_task_required mode, `reviewFindings` is optional (resolved from plugin evidence automatically). Examples simplified to omit `reviewFindings` parameter.

- `plan.ts`, `implement.ts`, `architecture.ts` (`host_task_required` Mode B paths): restructured to resolve findings from invocation evidence when `args.reviewFindings` is absent. Obligation lookup moved before findings resolution. `effectiveFindings` variable unifies both paths. `evidenceInvocationId` bypasses `findAcceptedInvocationForFindings`.
- `buildHostTaskEvidence()` in `review-enforcement.ts` now passes `capturedRawFindings: rawFindings` to `buildInvocationEvidence`.

- `buildHostTaskEvidence()` in `review-enforcement.ts` now passes `capturedVerdict` from `CapturedFindings.overallVerdict` to `buildInvocationEvidence`.
- SDK-path `buildInvocationEvidence` call in `plugin-orchestrator.ts` also passes `capturedVerdict` for schema consistency.
- `validateReviewFindings()` in `review-validation.ts`: for `host_task_required` mode, invocation lookup relaxed (no `findingsHash`/`childSessionId` in predicate), sessionId check relaxed (skip hard block), hash comparison replaced with verdict comparison when `capturedVerdict` is present. Fallback to hash comparison when `capturedVerdict` is absent (legacy evidence backward compat).

- `buildHostTaskEvidence()` return type changed from `ReviewInvocationEvidence | null` to `HostTaskBindResult` (breaking — single caller updated).

- `EventHandlerDeps` interface extended with `emitSessionErrorAudit(sessionId, errorMessage, detail)` callback for audit trail integration.
- `PRECONDITION_REASONS` count updated from 37 to 38 entries.
- `VALIDATION_REASONS` count updated from 43 to 44 entries.
- `INFRA_REASONS` count updated from 28 to 29 entries.
- Total reason code count updated from 108 to 111.
- BUG-02 (Task Content Fabrication) reclassified from CODE-BUG to DESIGN-GAP after deep code analysis: L1-L4 enforcement layers validate review process integrity (by design), not content accuracy. Content fabrication detection requires architectural design (L5 content grounding layer).

- **`logging.mode` extended**: Schema now accepts `'console'` and `'file+console'` in addition to existing `'file'` and `'ui'`. Plugin logging builds console sinks for these modes. Console sink routes all levels to stderr (industry standard, stdout stays clean for CLI output).
- **ALS-scoped DI replaces global singleton**: `adapter-logger.ts` uses `AsyncLocalStorage` instead of a global variable. Plugin hooks run in `runWithAdapterLoggerAsync()` scopes. CLI uses `setAdapterLogger()` with `finally { resetAdapterLogger() }` cleanup. Tests get automatic isolation.
- **`policy-snapshot.ts` `console.warn` replaced**: Direct `console.warn` calls replaced with `getAdapterLogger().warn()` for structured routing.
- **CLI structured logging**: `main()` now initializes a structured logger via `initCliLogger()`, logs `command_started`/`install completed`/`doctor completed`/`uninstall completed`, and logs malformed-JSON fallbacks in `install-helpers.ts`.
- **Reviewer fallback formalized**: Reviewer model structured-output incompatibility now blocks under `structured_required` policy and retries in text compatibility mode only when policy allows it. Capability is evaluated per invocation.
- **Lint cleanup**: Removed unnecessary type assertions and unused imports from plugin composition.
- **`pluginReviewFindings` renamed (from `_pluginReviewFindings`, PR #73)**: Leading underscore wrongly suggested internal/private field. Non-breaking rename since unreleased.
- **Dropped dead text-fallback parsers in review orchestrator (PR #73)**: Removed legacy text-fallback parsers (`extractResponseText`, etc.) — the orchestrator only consults `info.structured_output` now.
- **Reasons registry split (P10c)**: Split `reasons.ts` (1204 lines) into 3 category modules. Public API unchanged via barrel exports.
- **Identity token verification**: Uses `jose` `jwtVerify` instead of custom Node.js crypto while preserving FlowGuard-owned key resolution.
- **TypeScript module resolution**: Moved from Bundler to NodeNext with explicit ESM specifiers.
- **`/hydrate` fail-closed discovery contract**: READY emitted only when discovery and profile-resolution artifacts are successfully persisted.
- **Codebase restructuring**: Extracted monolithic plugin into dedicated modules. Centralized tool name constants. Hardened evidence schemas with readonly annotations.
- **Command templates simplified**: All 20 command templates rewritten with action-oriented language. Shared governance rules extracted to `shared-rules.ts`.
- **AGENTS v3 mandate hardened**: Explicit Red Lines, action-oriented invariants, review verdict alignment.

- `onTaskToolAfter()` signature extended with optional `context?: TaskToolContext` parameter for tiered session ID resolution (backward compatible).
- `trackTaskEnforcement()` in `plugin-enforcement-tracking.ts` now extracts metadata and callID from hook input/output and passes them as `TaskToolContext` (v2).
- `plugin.ts` task handler restructured: resolves child session ID and injects it into `hookOutput.output` before `trackTaskEnforcement` captures findings.

### Removed

- **Stale empty `opencode.json`**: Deleted 0-byte `opencode.json` from repository root. Canonical config is `opencode.jsonc`.
- **Heuristic validation check executors (P10a)**: Removed `baselineTestQuality` and `baselineRollbackSafety` — dead code never called by any production path. `CheckExecutor` interface removed.

### Fixed

- **FG-REL-045 (Issue #196):** Make phase-aware host tool gate fail-closed on unreadable session state:
  - `plugin.ts`: replaced fail-open catch-swallow with explicit fail-closed behavior — mutating host tools (`bash`, `write`, `edit`) are now BLOCKED with `PLUGIN_ENFORCEMENT_UNAVAILABLE` when session state is missing or unreadable
  - Session directory exists but no state file → block
  - Session state file exists but is invalid/corrupt → block
  - No session directory on disk (fingerprint unresolved, reviewer subagent context) → allowed (existing behavior preserved)
  - 3 new integration tests: missing state file block, corrupt state block, enforcement error smoke; renamed "fail-open" test to "no session dir allowed"
  - Zero gate logic changes — `phase-tool-gate.ts` and `isHostToolAllowedInPhase` unchanged

- **reviewCard not displayed after plan/implement approval — LLM skips buried instruction (TEMPLATE-01)**: In a full team-policy run, the agent summarized the `reviewCard` field instead of presenting it verbatim after plan approval. Root cause: the reviewCard display instruction was buried in a sub-bullet of step 6 in the plan command template (`plan.ts:46`) — a position LLMs frequently skip. The implement template had no reviewCard instruction at all (`implement.ts:47` just said "Report the final status"). The architecture template had a dedicated `## Presentation` section (proven effective), but no Done-when mention. Fix: all four reviewCard-producing commands (plan, implement, architecture, review) now follow a consistent 3-layer enforcement pattern: (1) dedicated `## Presentation` section with explicit "never summarize, truncate, or omit" prohibition, (2) `reviewCard` mentioned in `Done-when` as a completion criterion, (3) review loop step cross-references the Presentation section instead of inlining the instruction. This matches the architecture template's proven pattern that was already working correctly.

- **DeepSeek R1 null-valued optional fields block all /plan invocations — SHOWSTOPPER (BUG-21)**: DeepSeek R1 consistently sends `{ planText: "...", selfReviewVerdict: null, reviewFindings: null }` for optional tool args. Because the before-hook receives raw (pre-Zod) args, `null` values reach enforcement logic before schema validation can strip them. This caused a 7-defect cascade: (1) `'key' in args` returns `true` for `null` values → mode detection incorrectly classifies Mode A (initial plan) as Mode B (verdict submission), (2) `!== undefined` checks pass for `null` (`null !== undefined` is `true`) → same mode mis-classification in tool execute(), (3) after misclassification, code attempts to read `sessionState.reviewAssurance.obligations` which is undefined after `/ticket` → `REVIEW_ASSURANCE_STATE_UNAVAILABLE` hard block. Fix (7 changes across 5 files): (G) `plugin.ts` before-hook: strip null-valued keys from args before `enforceBeforeVerdict` — ensures downstream code never sees explicit nulls; (A) `review-enforcement.ts:~471`: replace `'selfReviewVerdict' in args` with value-based check (`typeof === 'string' && length > 0`); (B) `review-enforcement.ts:~476-514`: wrap obligations access in `if (sessionState)` guard with graceful `REVIEW_ASSURANCE_STATE_UNAVAILABLE` only when sessionState exists but obligations are empty; (C) `review-enforcement.ts:~197`: same value-based fix in after-hook mode detection; (D) `plan.ts:~172-173`: replace `!== undefined` with `typeof string + length` for hasVerdict, `!= null && typeof object` for hasFindings; (E) `implement.ts:~156-157`: same as D; (F) `architecture.ts:~140-141`: same pattern with `isInitialSubmission` derivation. The null-stripping in the before-hook (Fix G) is the primary defense; fixes A-F are defense-in-depth for any path where raw args bypass the hook.

- **Stored capturedRawFindings with invalid attestation rejected by resolveHostTaskFindings (BUG-20b)**: After BUG-20 fix enabled attestation-free fallback binding, `buildHostTaskEvidence` stored `capturedRawFindings` INCLUDING the reviewer's invalid placeholder attestation (e.g. `toolObligationId: "review-obligation-fg-rel-030"`). Later, `resolveHostTaskFindings` re-parsed `capturedRawFindings` via `ReviewFindingsSchema.safeParse()` — which treats `attestation` as optional-but-must-be-valid (`z.optional()` = absent OR fully valid, NOT present-but-invalid). The invalid `toolObligationId` (not a UUID) caused safeParse to reject the ENTIRE findings object, returning null → `REVIEW_FINDINGS_REQUIRED` even though binding had succeeded. Fix: in `buildHostTaskEvidence`, when `!hasValidAttestation`, strip the `attestation` field from raw findings BEFORE `hashFindings()` and storage as `capturedRawFindings`. This ensures: (1) stored findings are always schema-valid, (2) `findingsHash` matches `capturedRawFindings` (both computed from same normalized object), (3) `resolveHostTaskFindings.safeParse()` succeeds. Normalization happens at the producer (where `hasValidAttestation` is already known) — the consumer's strict safeParse is correct behavior and should NOT be weakened.

- **Host-task evidence binding fails when reviewer attestation is absent — SHOWSTOPPER (BUG-20)**: In `host_task_required` mode, `buildHostTaskEvidence` hard-failed with `no_attestation` when the reviewer's `attestation.toolObligationId` was missing or not a valid UUID. Root cause: the LLM-constructed reviewer prompt in `host_task_required` mode (built by the agent, not the orchestrator) does NOT contain `obligationId`, `mandateDigest`, or `criteriaVersion` — because `buildHostTaskPolicyOutput` cannot include them (the obligation UUID is generated separately). The reviewer (DeepSeek R1) correctly writes `"not_provided_in_prompt"` as placeholder, which is not a UUID, causing binding to fail. This blocked the Task tool output → triggered BUG-19 fallback → `REVIEWER_UNAVAILABLE_STRICT` → agent resubmits plan → new obligation → same instruction → **infinite deadloop**. Fix: when `toolObligationId` is absent or not a valid UUID (regex `^[0-9a-f]{8}-...$`), fall back to tool-based obligation matching: find the newest unconsumed obligation of the matching type (`oType`). This is safe because: (1) plugin already validated the Task call via `matchPendingReview` (P34 1:1 contract), (2) `rawFindings` are first-party captured by the plugin hook, (3) at most one pending obligation per tool-type for plan/implement/architecture. Field mismatch checks for `mandateDigest`/`criteriaVersion`/`reviewedBy` are skipped when no valid attestation is present (they would always fail with placeholder values). The `no_attestation` bind outcome is removed from `HostTaskBindOutcome` — replaced by `no_matching_obligation` with `bindingMode: 'tool_fallback'` in diagnostic.

- **Test infrastructure: fulfillStrictReviewObligation missing capturedRawFindings (Batch 10)**: The test helper `fulfillStrictReviewObligation` correctly set `invocationMode: 'host_subagent_task'` and `hostVisible: true` in host_task_required mode but did NOT pass `capturedRawFindings` to `buildInvocationEvidence`. After the BUG-17 evidence-first fix, `resolveHostTaskFindings` requires `capturedRawFindings != null` on the invocation — so all tests using this helper cascaded into either `REVIEW_FINDINGS_REQUIRED` (direct) or "No matching review obligation found" (indirect, when the second plan call failed and no new obligation was created for the next iteration). Fix: pass `capturedRawFindings: findings` to the invocation evidence in host_task_required mode. Resolves 70 deterministic test failures across 11 test files.

- **Agent infinite loop when reviewer subagent unavailable (BUG-19)**: In `host_task_required` mode, `buildHostTaskPolicyOutput` instructs the agent to spawn a `flowguard-reviewer` subagent via the Task tool. If the reviewer agent is not installed (no `.opencode/agents/` directory), the agent cannot fulfill this instruction and resubmits `flowguard_plan` — creating a new obligation — producing the same instruction — infinite loop. Fix: (1) Added fallback instruction to `buildHostTaskPolicyOutput` next field ("If Task tool cannot spawn reviewer, submit selfReviewVerdict with reviewerUnavailable: true"). (2) All three tools (plan, implement, architecture) detect `args.reviewerUnavailable === true`: in strict mode → BLOCKED with `REVIEWER_UNAVAILABLE_STRICT`; in non-strict mode → synthetic self-review findings with `reviewMode: 'self'` unblock the workflow. (3) `ReviewFindings.reviewMode` Zod schema extended from `z.literal('subagent')` to `z.enum(['subagent', 'self'])`. (4) New reason code `REVIEWER_UNAVAILABLE_STRICT` registered (PRECONDITION category, count now 39).

- **Template hash stability updated for Batch 9/10 template changes**: `templates-hash.test.ts` expected hash updated to reflect template content changes from Batch 9 (reviewFindings optional in host_task_required mode, examples simplified) and Batch 10 (fallback instruction for reviewer unavailability).

- **Evidence-first findings resolution in host_task_required mode (BUG-17)**: In `host_task_required` mode, plugin-captured evidence is now the SOLE source of truth for review findings. Agent-submitted `reviewFindings` are completely ignored (warn-logged for observability). Previously, the code checked `args.reviewFindings` FIRST before falling back to evidence — allowing the non-deterministic LLM reconstruction path to introduce hash mismatches and BLOCKED states on every first attempt. All three tools (plan, implement, architecture) now share the same evidence-first pattern: `if (isHostTaskMode) → resolve from evidence; else if (args.reviewFindings) → validate via SDK path`. SDK path (`sdk_session_prompt`, `host_task_preferred` retry) continues to validate agent-submitted findings unchanged.

- **buildHostTaskPolicyOutput preserves iteration/planVersion context (BUG-16)**: The orchestrator's `buildHostTaskPolicyOutput` function previously overwrote the `next` field with a generic message, losing the `iteration=X` and `planVersion=Y` values from the original tool output. The agent uses these values to construct the subagent prompt, which must pass `promptContainsValue` enforcement. Without them, the first reviewer subagent call always failed with `SUBAGENT_PROMPT_MISSING_CONTEXT`. Fix: extracts the original meta via `extractContentMeta()` and appends `Context: iteration=X, planVersion=Y.` to the mutated next field.

- **Reviewer subagent instructed to not call FlowGuard tools (BUG-18)**: The mutated `next` field now includes the instruction "The reviewer subagent must NOT call any FlowGuard tools (flowguard_plan, flowguard_implement, flowguard_architecture) in its own session." This prevents the reviewer from calling `flowguard_plan` in its own session (which wastes tokens and creates confusion but was not a hard blocker due to evidence-binding working regardless).

- **Evidence-based findings resolution eliminates agent reconstruction (BUG-15 Stufe 2)**: In `host_task_required` mode, the agent no longer needs to submit `reviewFindings` — the plugin captures the complete raw findings in `capturedRawFindings` on `ReviewInvocationEvidence`, and the tool layer resolves them directly from invocation evidence via `resolveHostTaskFindings()`. This eliminates the fundamental brittleness of LLM-reconstructed findings JSON (key ordering, Zod stripping, hallucinated fields) and achieves 100% success rate for the plan-review-revision loop. Agent-submitted findings (SDK path) continue to work unchanged with full `validateReviewFindings` validation. Evidence-resolved findings skip `validateReviewFindings` (first-party, plugin-validated) and use `evidenceInvocationId` directly for obligation consumption — bypassing `findAcceptedInvocationForFindings` hash comparison entirely.

- **Hash mismatch breaks host_task_required revision loop (BUG-15)**: In `host_task_required` mode, the plan-review-revisions loop was 100% broken because `validateReviewFindings` compared a SHA-256 hash of the agent's reconstructed findings JSON against the plugin-captured `rawFindings` hash. These never match because: (1) Zod strips/transforms fields during agent submission, (2) LLM agents reconstruct JSON with different key ordering, (3) `JSON.stringify` is key-order-dependent. Fix: added `capturedVerdict` field to `ReviewInvocationEvidence` schema, populated from the plugin's first-party `CapturedFindings.overallVerdict`. For `host_task_required` mode, invocation lookup now matches by `obligationId` + `invocationMode` instead of requiring `findingsHash`, and validation verifies the submitted verdict against `capturedVerdict` instead of hash comparison. SDK path (`sdk_session_prompt`) unchanged — hash comparison remains correct there because the plugin injects findings and the agent returns them verbatim. No new reason codes (reuses `REVIEW_FINDINGS_HASH_MISMATCH` for verdict tamper). SessionId comparison also relaxed for `host_task_required` since the agent reconstructs `reviewedBy.sessionId` from text output.

- **Host-task plan-review loop never converges (BUG-14)**: The `host_task_required` review invocation path now resolves the child session ID via three-tiered resolution and injects it into the reviewer output before tracking — mirroring the SDK mode post-hoc injection (review-orchestrator.ts:1193-1202). Previously, `onTaskToolAfter` called `extractSubagentSessionId(taskResult)` which always returned `null` because the reviewer subagent cannot know its own session ID. This caused `buildHostTaskEvidence()` to always return `no_child_session`, blocking evidence creation and triggering infinite re-invocation. Tier 1: hook metadata `sessionID` (authoritative). Tier 2: text extraction from reviewer JSON (existing). Tier 3: synthetic `derived:call:${callID}` (guaranteed unique). No new reason codes introduced.
- **Architecture adrText/adrTitle SSOT violation (BUG-12)**: Architecture review prompt now always uses `sessionState.architecture.adrText` and `sessionState.architecture.title` (SSOT) instead of the LLM-supplied `toolArgs.adrText`/`toolArgs.title`. Same class of bug as BUG-09 (plan text SSOT). Additionally fixed a variable scoping bug where `adrText`/`adrTitle` were declared inside the `else if` block but referenced in the outer logging block — causing a silent `ReferenceError` when `toolArgs.adrText` was a string, which was caught by the outer try-catch and silently swallowed. Added mismatch logging (adrTextMismatch, toolArgsAdrTextLength) for observability.
- **SSRF in fetchUrlContent (BUG-13, Security)**: `/review` URL fetching now validates URLs before fetch with `validateReviewUrl()`. Blocks: non-HTTPS schemes (http, file, ftp, data, javascript), private/reserved IPv4 ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 0.0.0.0), private IPv6 (::1, fc00::/7, fe80::/10), and `localhost`. Redirect following disabled (`redirect: 'error'` instead of `redirect: 'follow'`) to prevent SSRF via open redirects. Uses existing `COMMAND_BLOCKED` reason code.
- **Host-task binding diagnostics opaque (F5)**: `buildHostTaskEvidence()` now returns a structured `HostTaskBindResult` with machine-readable `bindOutcome` and serializable `diagnostic` metadata for every code path (9 distinct outcomes). Previously the function returned `null` on 6 different failure paths with no indication of why binding failed — making real-run debugging impossible. The `plugin.ts` caller now emits 4 diagnostic log statements: `reviewer task completed`, `bind attempt` (with policy and pending obligation count), `evidence created` or `bind failed` (with outcome and diagnostic fields), and `output blocked` on `host_task_required` policy with null evidence.

- **Infinite reviewer re-invocation loop (BUG-07)**: Review obligation now blocked with `REVIEWER_INVOCATION_EXHAUSTED` after all subagent retry attempts fail in non-strict mode. Previously the obligation stayed `pending`, causing `findLatestPendingReviewObligation()` to rediscover it on every subsequent tool call and trigger another 3-attempt cycle — resulting in unbounded subagent sessions with no bindable results. Strict mode behavior unchanged (uses `blockReviewOutcome`).
- **Plan text corruption from LLM-supplied toolArgs (BUG-09)**: Plan review prompt now always uses `sessionState.plan.current.body` (SSOT) instead of preferring the LLM-supplied `toolArgs.planText`. After context-window compaction, the LLM may reconstruct a hallucinated or truncated plan text that corrupts the reviewer prompt. Added mismatch logging (planTextMismatch, toolArgsPlanTextLength) for observability.
- **Phase-aware host tool gate (BUG-03)**: Mutating host tools (`bash`, `write`, `edit`) are now blocked during investigation-only phases (`TICKET`, `PLAN`, `ARCHITECTURE`). Previously, all non-FlowGuard tools passed through the `tool.execute.before` hook without any phase check, allowing shell commands and file writes during planning. Read-only tools (`read`, `glob`, `grep`, `webfetch`) remain allowed. Fail-open for sessions without FlowGuard state (e.g. reviewer subagent sessions).
- **Subagent type authorization (BUG-08)**: Non-reviewer subagent types are now blocked at the plugin level as defense-in-depth. Previously, `tool.execute.before` only intercepted `task` calls with `subagent_type: 'flowguard-reviewer'` — all other subagent types passed through unchecked. Now any non-empty `subagent_type` other than `flowguard-reviewer` triggers a `SUBAGENT_TYPE_UNAUTHORIZED` enforcement error.
- **Session error audit trail (BUG-01)**: `session.error` SDK events are now persisted to the audit trail via `emitSessionErrorAudit` callback. Previously, session errors were only logged to the file/console logger and silently lost from the persistent audit chain. The composition root (`plugin.ts`) wires the callback to `appendReviewAuditEvent` with `error:SESSION_ERROR` event type.
- **Session error detail loss (BUG-06)**: The `session.error` event handler now extracts all available error context from SDK event properties — `code`, `stack`, and any non-standard supplementary properties. Previously only `error` or `message` (string) were extracted; stack traces, error codes, and metadata were silently discarded.
- **Doc-code mismatch in plugin-events (BUG-11)**: Module documentation claimed `session.idle` handling; corrected to `session.delete` which is the actual handled event type.

- **JSONC conformance — full trailing comma and comment support**: Replaced `strip-json-comments` with `jsonc-parser` for complete JSONC compatibility.
- **OpenCode config resolver prefers `opencode.jsonc`**: Installer and doctor now check `opencode.jsonc` first.
- **Plugin event and compaction hooks wired**: All four hooks registered. Lint errors fixed.
- **Plugin hook types aligned with OpenCode SDK**: Renamed types, added fields matching SDK definition.
- **Structured field priority aligned with SDK docs**: `invokeReviewer` now prefers `info.structured_output` over `info.structured`.
- **Docs synced to `opencode.jsonc`**: Installation, distribution model, independent review docs reference `opencode.jsonc`.
- **Compaction hook input contract hardened**: Removed optional chaining from `input.sessionID`.
- **Merge semantics documented**: FlowGuard installer follows OpenCode's merge semantics.
- **`@subagent` bypass claim marked NOT_VERIFIED**: Explicit marker in `independent-review.md`.
- **Fix review orchestrator parsing for NextAction footer outputs (#157)**: `isReviewRequired`, `buildMutatedOutput`, `buildReviewContentMutatedOutput` now use `parseToolResult()`.
- **Avoid deleting user files inside vendor directory on uninstall (#118)**: Only FlowGuard-owned tarballs removed.
- **Stop swallowing permission errors in safeRead/safeUnlink (#117)**: Permission errors now surfaced to callers.
- **Atomic write pattern for evidence and archive (#116)**: `atomicWrite()` exported from `persistence.ts`.
- **Transactional install rollback (#115)**: FlowGuard-owned artifacts rolled back on dependency install failure.
- **Redact token segments from verification errors (#114)**: No more base64 token content in error messages.
- **Reject private key material in JWK configuration (#113)**: Private key fields rejected via strict schema.
- **Doctor scope-aware config check (#106)**: Doctor checks only the relevant scope, not fallback.
- **Doctor exit code treats warnings as non-failing (#12)**: Only real errors cause exit 1.
- **Uninstall removes flowguard.json (#7)**: Config file removed on uninstall.
- **Uninstall removes task-hardening from opencode.json (#11)**: Task-deny rules cleaned up.
- **Uninstall removes package.json when FlowGuard-only (#9)**: Empty shell package.json deleted.
- **Desktop-owned heuristic uses exact match (#17)**: Exact-match instead of substring `includes()`.
- **`resolveTarget` respects `OPENCODE_CONFIG_DIR` (#19)**: Consistent with `persistence.ts`.
- **`detectCustomConfig` no longer false-positives on fresh install (#1)**: `defaultMode` not treated as customization.
- **Audit chain strict verification mode**: `verifyChain({ strict: true })` rejects legacy events without chain fields.
- **Strict audit verification in regulated paths**: Archive verification now checks audit chain integrity.
- **Regulated archive completion semantics**: Clean completion requires synchronous archive creation and verification.
- **Install test decomposition verified**: 174 original tests + 31 new tests, coverage preserved.

## [1.2.0-rc.2] - 2026-05-03

### Added

- **Obligation-bound standalone /review (P2)**: Every content-aware `/review` call creates a `ReviewObligation` (obligationType `review`, UUID, mandate digest, criteria version). Obligations are input-fingerprint-bound, validated through `validateStrictAttestation`, and consumed on success.
- **Invocation evidence for standalone /review (P3)**: Successful `/review` submissions record `ReviewInvocationEvidence` from accepted subagent-attested findings. Evidence carries source marking (`host-orchestrated` / `agent-submitted-attested`). Evidence reuse is detected via `hasEvidenceReuse()`.
- **Host-orchestrated content analysis for /review (P4)**: The plugin-orchestrator intercepts `CONTENT_ANALYSIS_REQUIRED` blocked responses from `/review`, loads external content, invokes the `flowguard-reviewer` subagent, and injects `pluginReviewFindings`. A dual-path template allows manual subagent invocation as fallback.
- **Review Report Card + Architecture Review Card (P5)**: `/review` and `/architecture` present structured markdown review cards aligned with the Plan Review Card pattern. Cards are derived presentation artifacts (never read back as runtime authority).
- **Review card immutable artifact persistence (P6)**: All three review cards are persisted as immutable derived evidence artifacts (`artifacts/<type>.<digest>.md` + `.json`) with `sourceStateHash` linking to session state.
- **Review/audit flow correctness (P0/P1)**: `runSingleIteration` no longer synthesizes `approve` at max iterations. Max review iterations without approval now fail closed with `MAX_REVIEW_ITERATIONS_REACHED`. Immutable assurance updates replace `.push()` mutations. Plan/Architecture Mode B block `SUBAGENT_FINDINGS_VERDICT_MISMATCH`. Atomic obligation persistence.
- **Content-aware `/review` (PR-E)**: `ReviewReferenceInput` extended with `text`, `prNumber`, `branch`, `url` fields. `/review` now loads external content (text blob, PR diff via `gh` CLI, branch diff via `git diff base...branch`, URL fetch via native `fetch`).
- **Documentation drift guards (PR-0b)**: CI-enforced guards that pin top-level docs, user command/phase/config/policy docs, troubleshooting reason-code docs, repository-local Markdown links, and Markdown code-block structure to runtime SSOTs.
- **Review obligation authority refactor (PR-A)**: Centralized reviewable tool to `ReviewObligationType` mapping in one integration SSOT and moved repeated obligation append/consume/response-field shaping into `review-assurance.ts`.
- **Architecture independent-review parity (F13)**: The `/architecture` ADR review loop now runs through the same independent-subagent pipeline as `/plan` and `/implement`.
- **Third reviewer LoopVerdict `unable_to_review` (P1.3)**: The reviewer subagent contract now accepts a third `overallVerdict` value for unreviewable artifacts. The runtime fails closed at every layer.
- **`promptContainsValue` contract documentation + edge tests (PR #73)**: Comprehensive JSDoc on the L3 prompt-context regex with 11 new EDGE tests.

### Fixed

- **ReviewReport Zod schema completeness field (PR-C)**: `ReviewReport` now includes `completeness: CompletenessReportSchema`.
- **Implementation review revision loop (PR-B)**: `flowguard_implement` returns `changes_requested` reviews to `IMPLEMENTATION`.
- **Reviewer attestation contract enforcement (PR #73)**: Mandate template now emits full six-field attestation block.
- **Reviewer session-id authority (PR #73)**: `invokeReviewer` overwrites `findings.reviewedBy.sessionId` with verified `childSessionId`.
- **Phantom `flowguard_continue` tool reference (PR #73)**: Removed reference to non-existent tool.
- **JSON-Schema ↔ Zod ReviewFindings drift (PR #73)**: Both schemas now align; new build-time guard.
- **Structured BLOCKED responses for plugin-hook enforcement (PR #73)**: Plugin hooks now return structured `RailBlocked` payloads.
- **12 missing reason codes registered (PR #73)**: Registry now has entries for all codes emitted by review-enforcement/audit paths.
- **Fingerprint folder for non-repo worktrees (PR #73)**: No longer creates rogue fingerprint folder outside git worktree.

### Changed

- **`pluginReviewFindings` renamed (from `_pluginReviewFindings`, PR #73)**: Non-breaking rename.
- **Dropped dead text-fallback parsers in review orchestrator (PR #73)**: Legacy text-fallback parsers removed.

## [1.2.0-rc.1] - 2026-04-23

See release notes: https://github.com/koeppben23/governed-runtime/releases/tag/v1.2.0

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
- `/review-decision` now enforces regulated approve identity hardening: explicit initiator/reviewer identity required, unknown actors blocked, and actor-match blocked via reason-coded outcomes
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
- Four-eyes reason code docs aligned to `FOUR_EYES_ACTOR_MATCH`, with additional regulated approve blockers `REGULATED_ACTOR_UNKNOWN` and `DECISION_IDENTITY_REQUIRED`
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
- **1182 tests passing**

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
