# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **GitHub Actions supply-chain pinning**: CI workflows and local composite-action metadata now pin external GitHub Actions to immutable commit SHAs, enforce the policy with `npm run check:actions-pinned`, and allow Docker actions only when pinned by digest. Documentation now states the workflow action trust boundary and Dependabot remains the update path for GitHub Actions.
- **Policy Snapshot Authority**: Centralized policy snapshot lifecycle with dedicated authority functions. Hydrate now freezes all governance-critical fields (actor classification, minimum actor assurance, identity provider configuration, self-review settings) from the resolved policy preset plus config overrides into the immutable session snapshot. Legacy or incomplete snapshots are normalized with safe mode-consistent defaults.
- **Policy-Aware Actor Resolution**: Decision paths (`/review-decision approve`) resolve actor identity with full identity provider context from the session's policy snapshot. Identity provider configuration hardening via schema-based validation rejects empty or structurally invalid configurations. Added reason codes for missing or invalid identity provider configuration with recovery guidance in the reason registry.
- **Governance Field Completeness**: The hydration policy input now forwards identity provider configuration, identity provider mode, and minimum actor assurance fields from config through to the policy snapshot, ensuring config-level identity and assurance settings are visible to all runtime enforcement checks.
- **Strict Independent Review Hardening**: Tightened strict independent review to require OpenCode SDK `json_schema` structured output (`data.info.structured_output`), mandatory reviewer attestation, one-use mandate-bound invocation evidence, `reviewMode: "subagent"` in strict orchestrated paths, and fail-closed blocking for strict orchestration failures. The installer now writes Task permission default-deny (`"*": "deny"`) followed by explicit `flowguard-reviewer` allow. The `independent-review-e2e` job now builds a release tarball, installs FlowGuard into a fresh repo, starts a real `opencode serve` runtime, and verifies FlowGuard command/tool/agent/permission surfaces through the server API. Provider-backed `/plan` + `/implement` LLM conversations remain operator acceptance tests because they require model credentials.

- **Independent Review Governance**: Fully implemented agent-orchestrated independent review with deterministic plugin-initiated subagent invocation, 4-level plugin enforcement, and 1:1 obligation matching. The FlowGuard plugin programmatically invokes the reviewer subagent via the OpenCode SDK client (`session.create()` + `session.prompt()`) -- no LLM decision involved. Non-strict orchestration failures preserve the LLM-driven Task fallback path; strict orchestration failures block fail-closed. Plan and implement tools accept structured `reviewFindings` from an independent review agent (OpenCode subagent orchestration). Installer deploys hidden `flowguard-reviewer` agent definition (`.opencode/agents/flowguard-reviewer.md`) and task permissions in `opencode.json`. Slash commands (`plan.md`, `implement.md`, `continue.md`) include tri-path orchestration: Path A1 (plugin-completed review via `_pluginReviewFindings`), Path A2 (fallback LLM-driven review via Task tool), Path B (self-review) when disabled. Tool responses include policy-conditional `next` messages with `INDEPENDENT_REVIEW_COMPLETED:` prefix for plugin-invoked mode, `INDEPENDENT_REVIEW_REQUIRED:` for fallback mode, and `reviewMode` field for observability. Author and reviewer artifacts stored separately (append-only): `plan.history` / `plan.reviewFindings` and `implementation` / `implReviewFindings`. Policy-controlled via `selfReview.subagentEnabled` and `selfReview.fallbackToSelf` (disabled by default, backward-compatible). Three-layer fail-closed enforcement: (1) structural validation -- review mode vs. policy, plan-version binding, iteration binding, mandatory findings for approval (`review-validation.ts`); (2) deterministic invocation -- plugin invokes reviewer via SDK client, mutates output, updates enforcement state (`review-orchestrator.ts`); (3) plugin-level enforcement with four levels -- L1 binary gate (`SUBAGENT_REVIEW_NOT_INVOKED`), L2 session-ID match (`SUBAGENT_SESSION_MISMATCH`), L3 prompt integrity (`SUBAGENT_PROMPT_EMPTY`, `SUBAGENT_PROMPT_MISSING_CONTEXT`), L4 findings integrity (`SUBAGENT_FINDINGS_VERDICT_MISMATCH`, `SUBAGENT_FINDINGS_ISSUES_MISMATCH`). Each subagent call satisfies exactly one pending review obligation (1:1 contract); plan and implement each require independent subagent invocations when both are pending. Enforcement logic in `review-enforcement.ts`, orchestration in `review-orchestrator.ts`, integrated via `tool.execute.before/after` hooks in `plugin.ts`. Status projections expose `latestReview` and `latestImplementationReview` summaries. Shared validation logic extracted to `review-validation.ts`.

- **IdP-Verified Actor Identity**: Added static-key JWT verification plus JWKS key resolution (`identityProvider.mode: 'static' | 'jwks'`). `static` uses JWK/PEM `signingKeys`; `jwks` uses exactly one authority (`jwksPath` or HTTPS `jwksUri`) with kid-based key lookup (no first-key fallback). Remote JWKS adds TTL caching via `cacheTtlSeconds` (default 300) and fail-closed refresh behavior. Supports RS256 and ES256 signature verification via `jose` (`jwtVerify`) with FlowGuard-owned key resolution. Token file path via `FLOWGUARD_ACTOR_TOKEN_PATH`. `identityProviderMode: 'optional' | 'required'` controls session creation behavior; optional mode degrades to claim/env/git fallback on IdP verification errors, required mode remains fail-closed. Policy snapshot stores typed `identityProvider` config (no `unknown` pass-through). Added typed IdP error taxonomy. `IDP_TOKEN_MISSING`, `IDP_TOKEN_INVALID`, `IDP_TOKEN_KID_MISSING`, `IDP_TOKEN_HEADER_INVALID`, `IDP_KEY_NOT_FOUND`, `IDP_JWKS_PATH_MISSING`, `IDP_JWKS_URI_INVALID`, `IDP_JWKS_READ_FAILED`, `IDP_JWKS_FETCH_FAILED`, `IDP_JWKS_INVALID`, `IDP_JWKS_KEY_NOT_FOUND`, `IDP_JWKS_ALGORITHM_MISMATCH`, `IDP_ALGORITHM_NOT_ALLOWED`, `IDP_SIGNATURE_INVALID`, `IDP_ISSUER_MISMATCH`, `IDP_AUDIENCE_MISMATCH`, `IDP_EXPIRED`, `IDP_NOT_YET_VALID`, `IDP_SUBJECT_MISSING`, `IDP_CLAIM_MAPPING_INVALID`, `IDP_NOT_CONFIGURED`, `IDP_CONFIG_INVALID`.
- **Actor Assurance Architecture**: Three-tier assurance model (`best_effort`, `claim_validated`, `idp_verified`) with source/assurance separation. `minimumActorAssuranceForApproval` replaces `requireVerifiedActorsForApproval` boolean. Zod coercion from legacy `verified` to `claim_validated`. `ActorInfo` extended with `verificationMeta`. Status projections updated.
- **Visible `/status` orientation command**: Added user-facing `/status` command mapped internally to `flowguard_status` with focused detail flags: `--why-blocked`, `--evidence`, `--context`, `--readiness`. Status projections now expose canonical blocked/context/readiness surfaces and enhanced evidence slot detail without adding independent runtime authority.
- **Non-interactive fail-closed mandate clarity**: AGENTS + agent guidance + command/distribution docs now explicitly require headless/non-interactive paths to return `BLOCKED` with exact missing inputs and recovery guidance instead of relying on follow-up questions.
- **Validated Actor Claim Bridge**: Added local actor claim support via `FLOWGUARD_ACTOR_CLAIMS_PATH`. If set, FlowGuard reads validated actor claim JSON before env/git fallback. Invalid, expired, or missing required claims fail closed with explicit reason codes. Claim-based identities use `source: 'claim'` and are normalized into the actor assurance model as `claim_validated`.
- **Config as Runtime Authority**: Profile resolution follows explicit > config > detected > baseline priority. `profileId: undefined` means auto-detect, `profileId: "baseline"` means explicit baseline (not auto-detect sentinel). Config iteration limits (`maxSelfReviewIterations`, `maxImplReviewIterations`) are persisted in policySnapshot for new sessions. Existing sessions retain snapshot values.
- **Runtime Policy Mode Unification**: Unified fallback for all runtime surfaces (plugin, status, etc.): `state > config > solo`. Previously plugin used `team` as fallback, now uses `solo`. Added `resolveRuntimePolicyMode()` in `src/config/policy.ts` as central function.
- **Actor Identity Bridge**: Minimal best-effort operator identity for audit attribution. `resolveActor()` resolves identity at hydrate time via `FLOWGUARD_ACTOR_ID` env → `git config user.name` → `unknown` fallback. `actorInfo` (id, email, source) stored in `SessionState` and passed to lifecycle, tool_call, and decision audit events. Machine-only events (transition, error) excluded. Hash-backward-compatible: absent `actorInfo` produces identical chain hashes to pre-bridge events.
- **Enterprise readiness**: Added consolidated control narrative for enterprise/security/procurement review. Documents system boundary, trust model, regulated guarantees, tamper-evident vs tamper-prevention scope, threat mitigations, residual risks, and deferred scope.
- **Central policy authority baseline**: Added explicit central policy distribution model via `FLOWGUARD_POLICY_PATH`. If set, central policy file must exist and validate. Resolution semantics: requested mode constrained by central minimum; weaker-than-central is blocked. `policySnapshot` includes applied source/provenance fields and `flowguard_status` surfaces applied-policy evidence.
- **Database engine detection in discovery**: Stack detection now derives database engines from repo evidence (Maven/Gradle dependencies, package.json deps, docker-compose image refs, Testcontainers modules) and surfaces them in `detectedStack.items` as `kind: "database"` with optional version when image tags are unambiguous.
- **Python/Rust/Go ecosystem detection in discovery**: Stack detection now derives root-level Python, Rust, and Go ecosystem signals from manifest/toolchain evidence (`pyproject.toml`, `.python-version`, `requirements*.txt`, `uv.lock`, `poetry.lock`, `Cargo.toml`, `rust-toolchain*`, `go.mod`, `.golangci.*`) and surfaces them in `detectedStack.items`.
- **Verification output contract hardening**: Hardened `/plan`, `/implement`, and `/review` output contracts to require visible verification sections: `/plan` requires `## Verification Plan` with Source citation for each check or NOT_VERIFIED fallback; `/implement` requires `## Verification Evidence` distinguishing Planned checks from Executed checks; `/review` checks for verificationCandidates vs generic command mismatches and flags them as defects.
- **Module-scoped stack detection**: Added scoped stack facts for monorepos. Nested manifests (`apps/*/package.json`, `packages/*/package.json`, `services/*/pom.xml`, etc.) now surface as `detectedStack.scopes` without globalizing root facts. Supports depth 1-3 paths, ignores `examples/`, `fixtures/`, `docs/`, `scripts/`, enforces max 20 scopes and 25 items per scope.
- **Verification Command Planner**: Added advisory `verificationCandidates` surfaced via `flowguard_status`, derived deterministically from repository evidence with priority: package scripts > Java wrappers (`./mvnw`, `./gradlew`) > detected-tool fallbacks. Commands are planner output only (never auto-executed). Placeholder script filtering now covers conservative bogus command forms across verification scripts (`exit 1`, `echo ... no test specified ...`, `echo TODO`, `echo not implemented`, `TODO`, `not implemented`) to avoid false high-confidence candidates; fallback candidates remain eligible.
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
- **External references for `/ticket` and `/review`**: Both commands now accept structured external references with audit provenance. `/ticket` supports Jira URLs, ADO work items, GitHub Issues, Confluence docs, branch names, commit SHAs, and other external sources via `references[]` (type, source, title, extractedAt). `/review` accepts PR URLs, branch names, and commit references. Input origin is tracked via `inputOrigin` (manual_text, external_reference, mixed, workspace, branch, pr, unknown). Templates instruct the LLM agent to extract content via `webfetch` before calling FlowGuard tools — FlowGuard itself never fetches URLs. Redaction layer redacts `references[].ref` and `.title` in exported review reports.
- **TypeDoc API Reference**: Added TypeDoc-based browsable TypeScript API documentation with three entry points (`@flowguard/core`, `@flowguard/core/integration`, `@flowguard/core/integration/tools`). Generated via `npm run docs`, deployed to GitHub Pages via CI (`docs.yml`). Top-level `@packageDocumentation` with package structure, policy mode overview, and architecture principles.
- **Governance test hardening**: Added deterministic coverage for actor assurance, policy snapshot regression, state machine invariants, audit/archive tampering, and legacy session-state upgrades. The suites cover terminal phase blocks, deterministic replay, policy mode variance, table-driven assurance tiers, identity-provider fail-closed behavior, archive tamper detection, and `normalizePolicySnapshotWithMeta` migration paths.

- **StrykerJS mutation testing**: Introduced mutation testing for security-critical governance code with the Vitest test runner, per-test coverage analysis, and TypeScript checker integration. CI runs mutation testing with the configured score threshold and uploads mutation reports for survivor analysis.

### Changed

- Identity token verification now uses `jose` `jwtVerify` instead of custom Node.js crypto verification while preserving FlowGuard-owned key resolution, fail-closed behavior, and existing IdP error-code taxonomy.
- CI now enforces ACP smoke coverage via dedicated `acp-smoke` job (`RUN_OPENCODE_ACP_TESTS=1`) and fails closed when `opencode` is unavailable on the runner.
- TypeScript module resolution moved from Bundler to NodeNext. Source imports now use explicit Node ESM specifiers (`.js` / `/index.js`) and build no longer rewrites compiled output post-`tsc`.
- ESM integrity verification now uses `scripts/check-esm-imports.js` as a strict dist validation step.
- Product and README collateral now align with verified-claim actor attribution semantics (`claim` verified; `env`/`git`/`unknown` best-effort) and headless fail-closed behavior.
- Documentation and product collateral were aligned to runtime SSOT: command allowlists, configuration path terminology (`workspace .../config.json`), and external-facing wording now match current FlowGuard behavior.
- CI install smoke tests now use a real packed tarball (`npm pack`) instead of a mock tarball, so install verification exercises the actual artifact path.
- SOLO_POLICY now allows 2 self-review iterations (up from 1), enabling single revision after initial review before convergence. Team remains at 3.
- `/hydrate` now enforces a fail-closed discovery contract for new sessions: READY is emitted only when discovery and profile-resolution artifacts are successfully persisted and `discoveryDigest`/`discoverySummary` are non-null.
- Workspace `config.json` is now materialized as a required artifact (install + hydrate self-heal) and doctor reports missing config as an error instead of silently accepting defaults.
- `/hydrate` now fail-closes on invalid existing workspace `config.json` (`WORKSPACE_CONFIG_INVALID`) instead of proceeding with implicit defaults.
- Governance commands now fail-closed when required derived ticket/plan artifacts are missing, malformed, or content/hash-inconsistent with ticket/plan evidence digests (`EVIDENCE_ARTIFACT_MISSING`, `EVIDENCE_ARTIFACT_MISMATCH`).
- State + artifact persistence now performs best-effort rollback semantics (state rollback + cleanup of newly created artifact files) on materialization failures.
- Compliance mapping filename corrected to `docs/marisk-mapping.md` and documentation index now links all compliance mappings and agent-guidance docs.
- **Codebase restructuring**: Extracted the monolithic plugin into dedicated modules (logging, helpers, enforcement tracking, review audit, review state, workspace). Centralized tool name constants into a single SSOT module. Hardened all evidence schemas with readonly annotations. Consolidated duplicated patterns: parameter objects, loop-state builders, profile templates, and review-outcome blocking.
- AGENTS v3 mandate hardened with explicit Red Lines, action-oriented invariants, and review verdict alignment (`approve` / `changes_requested`).

### Fixed

- Telemetry code is no longer excluded from coverage collection in `vitest.config.ts`, so telemetry tests contribute to global coverage thresholds.
- Fixed product one-pager title typo: "AI Engineering Governance Platform".
- OpenCode-style non-UUID session IDs (`ses_...`) are now accepted across binding and audit event schemas, preventing hydration/runtime schema validation failures.
- Integration and E2E tests now run with OpenCode-style session IDs and include regression assertions for hydrate discovery/config contracts.
- Added `src/documentation/__tests__/agents-v3.test.ts` to enforce AGENTS v3 structure, marker rules, high-risk verification policy, guidance link integrity, and rubric presence.
- Eval-suite reference links to OpenAI and Anthropic docs were revalidated and documented for traceability.
- **Audit chain strict verification mode**: `verifyChain({ strict: true })` rejects legacy events without chain fields as integrity failures. Adds typed `ChainVerificationReason` (`CHAIN_BREAK` | `LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE`) and `reason` field to `ChainVerification`. Compliance summary now distinguishes strict failures from chain breaks in detail messages.
- **Strict audit verification in regulated paths**: Archive verification (`verifyArchive`) now verifies audit chain integrity. When `manifest.policyMode === "regulated"`, strict mode rejects unchained legacy events. Non-regulated modes remain legacy-tolerant for backward compatibility. New finding code `audit_chain_invalid` reports chain breaks and strict-mode violations with diagnostic counts. This is the first production call-site for `verifyChain`.
- **Regulated archive completion semantics**: Regulated clean completion (`EVIDENCE_REVIEW → APPROVE → COMPLETE`) now requires synchronous archive creation and verification success. New `archiveStatus` field on `SessionState` tracks the archive lifecycle (`pending` → `created` → `verified` or `failed`). Checksum sidecar failure is fatal in regulated mode. Non-regulated sessions retain existing fire-and-forget auto-archive behavior. Aborted sessions are excluded from the archive guarantee.

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
