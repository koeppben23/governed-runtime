# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

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

### Removed

- **Stale empty `opencode.json`**: Deleted 0-byte `opencode.json` from repository root. Canonical config is `opencode.jsonc`.
- **Heuristic validation check executors (P10a)**: Removed `baselineTestQuality` and `baselineRollbackSafety` — dead code never called by any production path. `CheckExecutor` interface removed.

### Fixed

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
