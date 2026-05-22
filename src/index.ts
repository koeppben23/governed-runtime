/**
 * @packageDocumentation
 *
 * # FlowGuard API
 *
 * Host-aware governance runtime for AI-assisted software delivery. FlowGuard
 * enforces governed development workflows with hash-chained audit trails,
 * policy-bound decision enforcement, and evidence-first compliance.
 *
 * OpenCode currently provides the strongest synchronous enforcement path through
 * its plugin integration. Claude Code and Codex are supported through MCP,
 * hooks, and native packaging with hook-gated, platform-limited guarantees.
 *
 * ## Package Structure
 *
 * | Entry Point | Purpose |
 * |-------------|---------|
 * | `@flowguard/core` | Core schemas, machine/policy APIs, audit/archive verification, logging |
 * | `@flowguard/core/integration` | Host integration surfaces, including OpenCode tool/plugin bindings |
 * | `@flowguard/core/integration/tools` | Individual tool definitions |
 * | `@flowguard/core/testing` | Test utilities (`createTestContext`) |
 *
 * ## Quick Start
 *
 * ```ts
 * import { executeTicket, FlowGuardPolicy, REGULATED_POLICY } from '@flowguard/core';
 * ```
 *
 * ## Policy Modes
 *
 * - **solo** — automatic approval, no human gates
 * - **team** — human-gated at review points
 * - **team-ci** — CI auto-approve, degrades to team without CI context
 * - **regulated** — mandatory four-eyes, evidence completeness enforcement
 *
 * ## Architecture
 *
 * Fail-closed: ambiguity blocks, never guesses.
 * Deterministic: same state + input = same result.
 * Evidence-first: every phase produces verifiable artifacts.
 * Policy-bound: every decision traced to a policy version.
 *
 * @module flowguard
 * @description Public API for the FlowGuard runtime package.
 *
 * This barrel exports the stable public surface. Internal modules
 * (adapters, individual collectors, machine topology, rail executors)
 * are available via direct imports for tests and internal tooling.
 *
 * Consumer entry points:
 * - `@flowguard/core`                — this file (schemas, machine, policy, audit, archive, logging)
 * - `@flowguard/core/integration`    — Host integration surfaces, including OpenCode tool/plugin bindings
 * - `@flowguard/core/testing`         — Test utilities only
 *
 * Several exports, such as `SessionState`, are runtime Zod schemas.
 * Use `z.infer<typeof SessionState>` for the corresponding TypeScript type.
 *
 * @version v3
 */

// ─── State Model ─────────────────────────────────────────────────────────────

/** @public */
export { Phase, Event, Transition, SessionState } from './state/schema.js';

export type {
  BindingInfo,
  TicketEvidence,
  ArchitectureDecision,
  AdrStatus,
  PlanEvidence,
  PlanRecord,
  SelfReviewLoop,
  ValidationResult,
  ImplEvidence,
  ImplReviewResult,
  ReviewDecision,
  ErrorInfo,
  CheckId,
  LoopVerdict,
  RevisionDelta,
  PolicySnapshot,
} from './state/evidence.js';

export {
  PolicySnapshotSchema,
  ActorInfoSchema,
  REQUIRED_ADR_SECTIONS,
  validateAdrSections,
} from './state/evidence.js';

// ─── Machine (High-Level Control Flow) ───────────────────────────────────────

/** @public */
export { Command, isCommandAllowed } from './machine/commands.js';
/** @public */
export { evaluate } from './machine/evaluate.js';
/** @public */
export type { EvalResult } from './machine/evaluate.js';
export { resolveNextAction, ACTION_CODES } from './machine/next-action.js';
export type { NextAction } from './machine/next-action.js';

// ─── Rail Result Types ───────────────────────────────────────────────────────

export type {
  RailResult,
  RailOk,
  RailBlocked,
  RailContext,
  TransitionRecord,
  ConvergenceResult,
  IterationResult,
} from './rails/types.js';

// ─── Config ──────────────────────────────────────────────────────────────────

export {
  type RepoSignals,
  type ProfileDetectionInput,
  type FlowGuardProfile,
  ProfileRegistry,
  baselineProfile,
  javaProfile,
  angularProfile,
  typescriptProfile,
  defaultProfileRegistry,
} from './config/profile.js';

/** @public */
export {
  type AuditPolicy,
  type FlowGuardPolicy,
  PolicyConfigurationError,
  SOLO_POLICY,
  TEAM_POLICY,
  REGULATED_POLICY,
  getPolicyPreset,
  policyModes,
} from './config/policy.js';

/** @internal */
export {
  type BlockedCategory,
  type BlockedReason,
  type FormattedBlock,
  BlockedReasonRegistry,
  defaultReasonRegistry,
  blocked,
} from './config/reasons.js';
export { createPolicySnapshot } from './config/policy.js';

/** @public */
export {
  FlowGuardConfigSchema,
  type FlowGuardConfig,
  type LogLevel,
  DEFAULT_CONFIG,
} from './config/flowguard-config.js';

// ─── Logging ─────────────────────────────────────────────────────────────────

export { type LogEntry, type LogSink } from './logging/index.js';
/** @public */
export { type FlowGuardLogger, createLogger, createNoopLogger } from './logging/index.js';

// ─── Audit ───────────────────────────────────────────────────────────────────

export {
  type ActorInfo,
  type AuditEventKind,
  type TransitionDetail,
  type ToolCallDetail,
  type ErrorDetail,
  type LifecycleDetail,
  type TypedDetail,
  type ChainedAuditEvent,
} from './audit/types.js';

/** @internal */
export {
  GENESIS_HASH,
  computeChainHash,
  finalizeWithTimestampEvidence,
  createTransitionEvent,
  createToolCallEvent,
  createErrorEvent,
  createLifecycleEvent,
  summarizeArgs,
} from './audit/types.js';

/** @public */
export {
  type EventVerification,
  type ChainVerification,
  verifyEvent,
  verifyChain,
  getLastChainHash,
} from './audit/integrity.js';

/** @internal */
export {
  type AuditFilter,
  bySession,
  byPhase,
  byPhases,
  byActor,
  byKind,
  byEvent,
  byTimeRange,
  byDetail,
  allOf,
  anyOf,
  not,
  filterEvents,
  sessionEvents,
  transitionEvents,
  toolCallEvents,
  errorEvents,
  distinctSessions,
  countByKind,
  countByPhase,
  timeSpan,
} from './audit/query.js';

export {
  type TimelineEntry,
  type SessionTimeline,
  type ComplianceCheck,
  type ComplianceSummary,
  generateTimeline,
  generateComplianceSummary,
} from './audit/summary.js';

export {
  type EvidenceSlotStatus,
  type FourEyesStatus,
  type CompletenessSummary,
  type CompletenessReport,
  evaluateCompleteness,
} from './audit/completeness.js';

// ─── Timestamp Assurance ────────────────────────────────────────────────────

export {
  type TimestampAssuranceStatus,
  type TimestampSource,
  type NtpEvidence,
  type TsaEvidence,
  type TsaVerificationStatus,
  type TimestampEvidence,
  type TimestampAssuranceMode,
  DEFAULT_TIMESTAMP_ASSURANCE,
} from './audit/timestamp-types.js';

export { computeCanonicalEventDigest } from './audit/canonical-digest.js';

export {
  type TimestampAuthorityProvider,
  type TimestampVerifier,
  MockTimestampAuthorityProvider,
  MockTimestampVerifier,
  MOCK_TSA_FIXTURE_TOKEN,
} from './audit/tsa-provider.js';
export { HttpTimestampAuthorityProvider } from './audit/rfc3161-http-provider.js';
export { PkijsTimestampVerifier } from './audit/rfc3161-pkijs-verifier.js';
export { verifyTimestampTokensForEvents } from './audit/timestamp-token-verification.js';
export type {
  TimestampTokenFinding,
  TimestampTokenVerificationResult,
} from './audit/timestamp-token-verification.js';

export { checkNtpClock } from './audit/ntp-check.js';
export type { NtpCheckResult } from './audit/ntp-check.js';

export { resolveTimestampEvidence } from './audit/timestamp-resolution.js';

export {
  verifyTimestampMonotonicity,
  verifyTsaMessageImprint,
  verifyTimestampEvidencePresence,
} from './audit/timestamp-verification.js';

// ─── Archive ─────────────────────────────────────────────────────────────────

export {
  type ArchiveFindingCode,
  type ArchiveFindingSeverity,
  type ArchiveFinding,
  type ArchiveManifest,
  type ArchiveVerification,
  ArchiveFindingCodeSchema,
  ArchiveManifestSchema,
  ArchiveVerificationSchema,
  ArchiveFindingSchema,
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
} from './archive/types.js';

/** @public */
export { verifyArchive } from './adapters/workspace/index.js';
