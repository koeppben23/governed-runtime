/**
 * @module governance
 * @description Root barrel export for the governance runtime package.
 *
 * Exports organized by layer:
 * - State: Phase, Event, SessionState, evidence types
 * - Machine: topology, guards, commands, evaluator
 * - Rails: all rail executors + types
 * - Config: policies, profiles, reasons
 * - Audit: event types, integrity, query, summary, completeness
 * - Adapters: persistence, git, binding, context
 *
 * @version v1
 */

// ─── Layer 1: State Model ────────────────────────────────────────────────────

export { Phase, Event, Transition, SessionState } from "./state/schema";

export type {
  BindingInfo,
  TicketEvidence,
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
} from "./state/evidence";

export { PolicySnapshotSchema } from "./state/evidence";

// ─── Layer 2: Machine ────────────────────────────────────────────────────────

export { TRANSITIONS, USER_GATES, TERMINAL, resolveTransition } from "./machine/topology";
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
  GUARDS,
} from "./machine/guards";
export { Command, isCommandAllowed } from "./machine/commands";
export { evaluate } from "./machine/evaluate";
export type { EvalResult } from "./machine/evaluate";

// ─── Layer 3: Rails ──────────────────────────────────────────────────────────

export type { RailResult, RailOk, RailBlocked, RailContext, TransitionRecord, ConvergenceResult, IterationResult } from "./rails/types";
export { autoAdvance, applyTransition, runConvergenceLoop, runSingleIteration, createPolicyEvalFn, DEFAULT_MAX_REVIEW_ITERATIONS } from "./rails/types";
export { executeHydrate } from "./rails/hydrate";
export type { HydrateInput } from "./rails/hydrate";
export { executeTicket } from "./rails/ticket";
export { executePlan } from "./rails/plan";
export { executeReviewDecision } from "./rails/review-decision";
export { executeValidate } from "./rails/validate";
export { executeImplement } from "./rails/implement";
export { executeContinue } from "./rails/continue";
export { executeReview } from "./rails/review";
export { executeAbort } from "./rails/abort";

// ─── Layer 4: Adapters ──────────────────────────────────────────────────────

export {
  readState,
  writeState,
  writeReport,
  govDir,
  statePath,
  reportPath,
  auditPath,
  stateExists,
  readReport,
  appendAuditEvent,
  readAuditTrail,
  PersistenceError,
} from "./adapters/persistence";
export {
  resolveRoot,
  isGitRepo,
  currentBranch,
  isClean,
  changedFiles,
  diffFiles,
  stagedFiles,
  headCommit,
  listRepoSignals,
  GitError,
} from "./adapters/git";
export { fromOpenCodeContext } from "./adapters/binding";
export { createRailContext } from "./adapters/context";

// ─── Testing Utilities (import separately for test bundles) ──────────────────

export { createTestContext } from "./testing";

// ─── Layer 5: Config (Extension Points) ──────────────────────────────────────

export {
  type RepoSignals,
  type CheckExecutor,
  type GovernanceProfile,
  ProfileRegistry,
  baselineProfile,
  javaProfile,
  angularProfile,
  typescriptProfile,
  defaultProfileRegistry,
} from "./config/profile";

export {
  type AuditPolicy,
  type GovernancePolicy,
  SOLO_POLICY,
  TEAM_POLICY,
  REGULATED_POLICY,
  resolvePolicy,
  policyModes,
  createPolicySnapshot,
} from "./config/policy";

export {
  type BlockedCategory,
  type BlockedReason,
  type FormattedBlock,
  BlockedReasonRegistry,
  defaultReasonRegistry,
  blocked,
} from "./config/reasons";

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
} from "./audit/types";

export {
  type EventVerification,
  type ChainVerification,
  verifyEvent,
  verifyChain,
  getLastChainHash,
} from "./audit/integrity";

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
} from "./audit/query";

export {
  type TimelineEntry,
  type SessionTimeline,
  type ComplianceCheck,
  type ComplianceSummary,
  generateTimeline,
  generateComplianceSummary,
} from "./audit/summary";

export {
  type EvidenceSlotStatus,
  type FourEyesStatus,
  type CompletenessSummary,
  type CompletenessReport,
  evaluateCompleteness,
} from "./audit/completeness";
