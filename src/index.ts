/**
 * @packageDocumentation
 *
 * # FlowGuard API
 *
 * Deterministic, fail-closed workflow engine for AI-assisted software delivery
 * within OpenCode. FlowGuard enforces governed development workflows with
 * hash-chained audit trails, policy-bound decision enforcement, and
 * evidence-first compliance.
 *
 * ## Package Structure
 *
 * | Entry Point | Purpose |
 * |-------------|---------|
 * | `@flowguard/core` | Types, config, policy, audit, archive — the core API |
 * | `@flowguard/core/integration` | OpenCode tool definitions + audit plugin |
 * | `@flowguard/core/integration/tools` | Individual tool definitions |
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
 * - `@flowguard/core`                — this file (types, config, audit, archive)
 * - `@flowguard/core/integration`    — OpenCode tool definitions + audit plugin
 *
 * @version v2
 */

// ─── State Model ─────────────────────────────────────────────────────────────

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

export { Command, isCommandAllowed } from './machine/commands.js';
export { evaluate } from './machine/evaluate.js';
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
  type CheckExecutor,
  type FlowGuardProfile,
  ProfileRegistry,
  baselineProfile,
  javaProfile,
  angularProfile,
  typescriptProfile,
  defaultProfileRegistry,
} from './config/profile.js';

export {
  type AuditPolicy,
  type FlowGuardPolicy,
  PolicyConfigurationError,
  SOLO_POLICY,
  TEAM_POLICY,
  REGULATED_POLICY,
  resolvePolicy,
  policyModes,
  createPolicySnapshot,
} from './config/policy.js';

export {
  type BlockedCategory,
  type BlockedReason,
  type FormattedBlock,
  BlockedReasonRegistry,
  defaultReasonRegistry,
  blocked,
} from './config/reasons.js';

export {
  FlowGuardConfigSchema,
  type FlowGuardConfig,
  type LogLevel,
  DEFAULT_CONFIG,
} from './config/flowguard-config.js';

// ─── Logging ─────────────────────────────────────────────────────────────────

export {
  type FlowGuardLogger,
  type LogEntry,
  type LogSink,
  createLogger,
  createNoopLogger,
} from './logging/logger.js';

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
  GENESIS_HASH,
  computeChainHash,
  createTransitionEvent,
  createToolCallEvent,
  createErrorEvent,
  createLifecycleEvent,
  summarizeArgs,
} from './audit/types.js';

export {
  type EventVerification,
  type ChainVerification,
  verifyEvent,
  verifyChain,
  getLastChainHash,
} from './audit/integrity.js';

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

export { verifyArchive } from './adapters/workspace/index.js';

// ─── Integration (OpenCode Tools + Plugin) ───────────────────────────────────

export {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  implement,
  validate,
  review,
  abort_session,
  archive,
  architecture,
  FlowGuardAuditPlugin,
} from './integration/index.js';

// ─── Testing Utilities ───────────────────────────────────────────────────────

export { createTestContext } from './testing.js';
