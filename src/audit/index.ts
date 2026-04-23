/**
 * @module audit
 * @description Barrel export for the FlowGuard audit subsystem.
 *
 * Provides:
 * - Structured audit event types and factory functions (types.ts)
 * - Hash chain integrity verification (integrity.ts)
 * - Query/filter utilities for audit trails (query.ts)
 * - Session timeline and compliance summary generation (summary.ts)
 *
 * @version v1
 */

// Structured event types + factories
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
} from './types.js';

// Hash chain integrity verification
export {
  type ChainVerifyOptions,
  type ChainVerificationReason,
  type EventVerification,
  type ChainVerification,
  verifyEvent,
  verifyChain,
  getLastChainHash,
} from './integrity.js';

// Query/filter utilities
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
} from './query.js';

// Summary generation
export {
  type TimelineEntry,
  type SessionTimeline,
  type ComplianceCheck,
  type ComplianceSummary,
  generateTimeline,
  generateComplianceSummary,
} from './summary.js';

// Evidence completeness matrix
export {
  type EvidenceSlotStatus,
  type FourEyesStatus,
  type CompletenessSummary,
  type CompletenessReport,
  evaluateCompleteness,
} from './completeness.js';
