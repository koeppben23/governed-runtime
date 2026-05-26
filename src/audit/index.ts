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
  type DecisionDetail,
  type TypedDetail,
  type ChainedAuditEvent,
  type EventBody,
  type ToolCallEventInput,
  type LifecycleEventInput,
  type DecisionEventInput,
  GENESIS_HASH,
  computeChainHash,
  finalizeWithTimestampEvidence,
  buildTransitionBody,
  buildToolCallBody,
  buildErrorBody,
  buildLifecycleBody,
  buildDecisionBody,
  createTransitionEvent,
  createToolCallEvent,
  createErrorEvent,
  createLifecycleEvent,
  createDecisionEvent,
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

// Timestamp assurance evidence
export {
  type TimestampAssuranceStatus,
  type TimestampSource,
  type NtpEvidence,
  type TsaEvidence,
  type TsaVerificationStatus,
  type TimestampEvidence,
  type TimestampAssuranceMode,
  DEFAULT_TIMESTAMP_ASSURANCE,
} from './timestamp-types.js';

export { computeCanonicalEventDigest } from './canonical-digest.js';

export {
  type TimestampAuthorityProvider,
  type TimestampVerifier,
  MockTimestampAuthorityProvider,
  MockTimestampVerifier,
  MOCK_TSA_FIXTURE_TOKEN,
} from './tsa-provider.js';
// HttpTimestampAuthorityProvider and PkijsTimestampVerifier moved to @flowguard/core/tsa
// (requires optional asn1js/pkijs packages).
export { verifyTimestampTokensForEvents } from './timestamp-token-verification.js';
export type {
  TimestampTokenFinding,
  TimestampTokenVerificationResult,
} from './timestamp-token-verification.js';

export { checkNtpClock } from './ntp-check.js';
export type { NtpCheckResult } from './ntp-check.js';

export { resolveTimestampEvidence } from './timestamp-resolution.js';
export type {
  TimestampResolutionInput,
  TimestampResolutionResult,
} from './timestamp-resolution.js';

export {
  verifyTimestampMonotonicity,
  verifyTsaMessageImprint,
  verifyTimestampEvidencePresence,
  canonicalDigestToUint8Array,
} from './timestamp-verification.js';
export type {
  TimestampMonotonicityResult,
  TimestampEvidenceCheck,
  EvidencePresenceCheck,
} from './timestamp-verification.js';
