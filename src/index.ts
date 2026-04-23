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

// ─── Layer 2: Machine ────────────────────────────────────────────────────────

export { TRANSITIONS, USER_GATES, TERMINAL, resolveTransition } from './machine/topology.js';
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
} from './machine/guards.js';
export { Command, isCommandAllowed } from './machine/commands.js';
export { evaluate } from './machine/evaluate.js';
export type { EvalResult } from './machine/evaluate.js';
export { resolveNextAction, ACTION_CODES } from './machine/next-action.js';
export type { NextAction } from './machine/next-action.js';

// ─── Layer 3: Rails ──────────────────────────────────────────────────────────

export type {
  RailResult,
  RailOk,
  RailBlocked,
  RailContext,
  TransitionRecord,
  ConvergenceResult,
  IterationResult,
} from './rails/types.js';
export {
  autoAdvance,
  applyTransition,
  runConvergenceLoop,
  runSingleIteration,
  createPolicyEvalFn,
  DEFAULT_MAX_REVIEW_ITERATIONS,
} from './rails/types.js';
export { executeHydrate } from './rails/hydrate.js';
export type { HydrateInput } from './rails/hydrate.js';
export { executeTicket } from './rails/ticket.js';
export { executePlan } from './rails/plan.js';
export { executeReviewDecision } from './rails/review-decision.js';
export { executeValidate } from './rails/validate.js';
export { executeImplement } from './rails/implement.js';
export { executeContinue } from './rails/continue.js';
export { executeReview, executeReviewFlow } from './rails/review.js';
export { executeArchitecture } from './rails/architecture.js';
export type { ArchitectureInput } from './rails/architecture.js';
export { executeAbort } from './rails/abort.js';

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
  writeConfig,
  writeDefaultConfig,
  writeDiscovery,
  readDiscovery,
  writeProfileResolution,
  writeDiscoverySnapshot,
  writeProfileResolutionSnapshot,
  PersistenceError,
} from './adapters/persistence.js';
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
} from './adapters/git.js';
export { fromOpenCodeContext } from './adapters/binding.js';
export { createRailContext } from './adapters/context.js';
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
} from './adapters/workspace/index.js';

// ─── Testing Utilities (import separately for test bundles) ──────────────────

export { createTestContext } from './testing.js';

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

// ─── Layer 5b: Logging ───────────────────────────────────────────────────────

export {
  type FlowGuardLogger,
  type LogEntry,
  type LogSink,
  createLogger,
  createNoopLogger,
} from './logging/logger.js';

// ─── Layer 6: Audit ──────────────────────────────────────────────────────────

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
  type VerificationCandidateKind,
  type VerificationCandidateConfidence,
  type VerificationCandidate,
  type VerificationCandidates,
  type DiscoveryResult,
  type ProfileCandidate,
  type RejectedCandidate,
  type ProfileResolution,
  type DiscoverySummary,
  type DetectedStack,
  type DetectedStackVersion,
  type DetectedStackTarget,
  type DetectedStackItem,
  type DetectedStackTargetEntry,
  type CollectorInput,
  type CollectorOutput,
  // Schemas
  EvidenceClassSchema,
  CollectorStatusSchema,
  DetectedItemSchema,
  StackInfoSchema,
  DiscoveryResultSchema,
  ProfileResolutionSchema,
  DiscoverySummarySchema,
  DetectedStackSchema,
  DetectedStackVersionSchema,
  DetectedStackTargetSchema,
  DetectedStackItemSchema,
  DetectedStackTargetEntrySchema,
  VerificationCandidateKindSchema,
  VerificationCandidateConfidenceSchema,
  VerificationCandidateSchema,
  VerificationCandidatesSchema,
  // Constants
  DISCOVERY_SCHEMA_VERSION,
  PROFILE_RESOLUTION_SCHEMA_VERSION,
} from './discovery/types.js';

export {
  runDiscovery,
  extractDiscoverySummary,
  extractDetectedStack,
  computeDiscoveryDigest,
} from './discovery/orchestrator.js';

export { planVerificationCandidates } from './discovery/verification-planner.js';

export { collectRepoMetadata } from './discovery/collectors/repo-metadata.js';
export { collectStack } from './discovery/collectors/stack-detection.js';
export { collectTopology } from './discovery/collectors/topology.js';
export { collectSurfaces } from './discovery/collectors/surface-detection.js';
export { collectCodeSurfaces } from './discovery/collectors/code-surface-analysis.js';
export { collectDomainSignals } from './discovery/collectors/domain-signals.js';

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
} from './archive/types.js';

export { verifyArchive } from './adapters/workspace/index.js';

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
} from './integration/index.js';
