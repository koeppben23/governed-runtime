/**
 * @module audit
 * @description Barrel export for the governance audit subsystem.
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
} from "./types";

// Hash chain integrity verification
export {
  type EventVerification,
  type ChainVerification,
  verifyEvent,
  verifyChain,
  getLastChainHash,
} from "./integrity";

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
} from "./query";

// Summary generation
export {
  type TimelineEntry,
  type SessionTimeline,
  type ComplianceCheck,
  type ComplianceSummary,
  generateTimeline,
  generateComplianceSummary,
} from "./summary";

// Evidence completeness matrix
export {
  type EvidenceSlotStatus,
  type FourEyesStatus,
  type CompletenessSummary,
  type CompletenessReport,
  evaluateCompleteness,
} from "./completeness";
