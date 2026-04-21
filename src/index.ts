/**
 * @module flowguard
 * @description Root barrel export for the FlowGuard runtime package.
 *
 * Exports organized by layer:
 * - State: Phase, Event, SessionState, evidence types
 * - Machine: topology, guards, commands, evaluator
 * - Rails: all rail executors + types
 * - Adapters: persistence (state, config, audit), git, binding, context
 * - Config: policies, profiles, reasons, FlowGuard config schema
 * - Logging: logger interface + factories
 * - Audit: event types, integrity, query, summary, completeness
 *
 * @version v1
 */

// ─── Layer 1: State Model ────────────────────────────────────────────────────

export { Phase, Event, Transition, SessionState } from './state/schema';

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
} from './state/evidence';

export { PolicySnapshotSchema, REQUIRED_ADR_SECTIONS, validateAdrSections } from './state/evidence';

// ─── Layer 2: Machine ────────────────────────────────────────────────────────

export { TRANSITIONS, USER_GATES, TERMINAL, resolveTransition } from './machine/topology';
export {
  type GuardFn,
  type GuardEntry,
  hasError,
  hasPlanReady,
  selfReviewMet,
  selfReviewPending,
  allValidationsPassed,
  checkFailed,
  implComplete,
  implReviewMet,
  implReviewPending,
  reviewDone,
  GUARDS,
} from './machine/guards';
export { Command, isCommandAllowed } from './machine/commands';
export { evaluate } from './machine/evaluate';
export type { EvalResult } from './machine/evaluate';
export { resolveNextAction, ACTION_CODES } from './machine/next-action';
export type { NextAction } from './machine/next-action';

// ─── Layer 3: Rails ──────────────────────────────────────────────────────────

export type {
  RailResult,
  RailOk,
  RailBlocked,
  RailContext,
  TransitionRecord,
  ConvergenceResult,
  IterationResult,
} from './rails/types';
export {
  autoAdvance,
  applyTransition,
  runConvergenceLoop,
  runSingleIteration,
  createPolicyEvalFn,
  DEFAULT_MAX_REVIEW_ITERATIONS,
} from './rails/types';
export { executeHydrate } from './rails/hydrate';
export type { HydrateInput } from './rails/hydrate';
export { executeTicket } from './rails/ticket';
export { executePlan } from './rails/plan';
export { executeReviewDecision } from './rails/review-decision';
export { executeValidate } from './rails/validate';
export { executeImplement } from './rails/implement';
export { executeContinue } from './rails/continue';
export { executeReview, executeReviewFlow } from './rails/review';
export { executeArchitecture } from './rails/architecture';
export type { ArchitectureInput } from './rails/architecture';
export { executeAbort } from './rails/abort';

// ─── Layer 4: Adapters ──────────────────────────────────────────────────────

export {
  readState,
  writeState,
  writeReport,
  statePath,
  reportPath,
  auditPath,
  configPath,
  stateExists,
  readReport,
  appendAuditEvent,
  readAuditTrail,
  readConfig,
  writeDefaultConfig,
  writeDiscovery,
  readDiscovery,
  writeProfileResolution,
  writeDiscoverySnapshot,
  writeProfileResolutionSnapshot,
  PersistenceError,
} from './adapters/persistence';
export {
  resolveRoot,
  isGitRepo,
  currentBranch,
  defaultBranch,
  isClean,
  changedFiles,
  diffFiles,
  stagedFiles,
  headCommit,
  listRepoSignals,
  remoteOriginUrl,
  GitError,
} from './adapters/git';
export { fromOpenCodeContext } from './adapters/binding';
export { createRailContext } from './adapters/context';
export {
  canonicalizeOriginUrl,
  normalizeForFingerprint,
  computeFingerprint,
  computeFingerprintFromRemote,
  computeFingerprintFromPath,
  validateFingerprint,
  validateSessionId,
  workspacesHome,
  configRoot,
  workspaceDir,
  sessionDir,
  initWorkspace,
  readWorkspaceInfo,
  writeSessionPointer,
  readSessionPointer,
  archiveSession,
  WorkspaceError,
  type MaterialClass,
  type FingerprintResult,
  type WorkspaceInfo,
  type SessionPointer,
} from './adapters/workspace';

// ─── Testing Utilities (import separately for test bundles) ──────────────────

export { createTestContext } from './testing';

// ─── Layer 5: Config (Extension Points) ──────────────────────────────────────

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
} from './config/profile';

export {
  type AuditPolicy,
  type FlowGuardPolicy,
  SOLO_POLICY,
  TEAM_POLICY,
  REGULATED_POLICY,
  resolvePolicy,
  policyModes,
  createPolicySnapshot,
} from './config/policy';

export {
  type BlockedCategory,
  type BlockedReason,
  type FormattedBlock,
  BlockedReasonRegistry,
  defaultReasonRegistry,
  blocked,
} from './config/reasons';

export {
  FlowGuardConfigSchema,
  type FlowGuardConfig,
  type LogLevel,
  DEFAULT_CONFIG,
} from './config/flowguard-config';

// ─── Layer 5b: Logging ───────────────────────────────────────────────────────

export {
  type FlowGuardLogger,
  type LogEntry,
  type LogSink,
  createLogger,
  createNoopLogger,
} from './logging/logger';

// ─── Layer 6: Audit ──────────────────────────────────────────────────────────

export {
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
} from './audit/types';

export {
  type EventVerification,
  type ChainVerification,
  verifyEvent,
  verifyChain,
  getLastChainHash,
} from './audit/integrity';

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
} from './audit/query';

export {
  type TimelineEntry,
  type SessionTimeline,
  type ComplianceCheck,
  type ComplianceSummary,
  generateTimeline,
  generateComplianceSummary,
} from './audit/summary';

export {
  type EvidenceSlotStatus,
  type FourEyesStatus,
  type CompletenessSummary,
  type CompletenessReport,
  evaluateCompleteness,
} from './audit/completeness';

// ─── Layer 7: Discovery ──────────────────────────────────────────────────────

export {
  // Types
  type EvidenceClass,
  type CollectorStatus,
  type DetectedItem,
  type RepoMetadata,
  type StackInfo,
  type TopologyKind,
  type ModuleInfo,
  type EntryPointInfo,
  type TopologyInfo,
  type SurfaceInfo,
  type LayerInfo,
  type SurfacesInfo,
  type CodeSurfaceSignal,
  type CodeSurfaceStatus,
  type CodeSurfaceBudget,
  type CodeSurfacesInfo,
  type DomainKeyword,
  type DomainSignals,
  type CommandHint,
  type ValidationHints,
  type DiscoveryResult,
  type ProfileCandidate,
  type RejectedCandidate,
  type ProfileResolution,
  type DiscoverySummary,
  type DetectedStack,
  type DetectedStackVersion,
  type DetectedStackTarget,
  type CollectorInput,
  type CollectorOutput,
  // Schemas
  EvidenceClassSchema,
  CollectorStatusSchema,
  DetectedItemSchema,
  DiscoveryResultSchema,
  ProfileResolutionSchema,
  DiscoverySummarySchema,
  DetectedStackSchema,
  DetectedStackVersionSchema,
  DetectedStackTargetSchema,
  // Constants
  DISCOVERY_SCHEMA_VERSION,
  PROFILE_RESOLUTION_SCHEMA_VERSION,
} from './discovery/types';

export {
  runDiscovery,
  extractDiscoverySummary,
  extractDetectedStack,
  computeDiscoveryDigest,
} from './discovery/orchestrator';

export { collectRepoMetadata } from './discovery/collectors/repo-metadata';
export { collectStack } from './discovery/collectors/stack-detection';
export { collectTopology } from './discovery/collectors/topology';
export { collectSurfaces } from './discovery/collectors/surface-detection';
export { collectCodeSurfaces } from './discovery/collectors/code-surface-analysis';
export { collectDomainSignals } from './discovery/collectors/domain-signals';

// ─── Layer 8: Archive ────────────────────────────────────────────────────────

export {
  type ArchiveFindingCode,
  type ArchiveFindingSeverity,
  type ArchiveFinding,
  type ArchiveManifest,
  type ArchiveVerification,
  // Schemas
  ArchiveFindingCodeSchema,
  ArchiveManifestSchema,
  ArchiveVerificationSchema,
  ArchiveFindingSchema,
  // Constants
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
} from './archive/types';

export { verifyArchive } from './adapters/workspace';

// ─── Layer 9: Integration (OpenCode Tools + Plugin) ──────────────────────────

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
} from './integration';
