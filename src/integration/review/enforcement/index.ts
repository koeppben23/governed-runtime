/**
 * @module integration/review/enforcement
 * @description Barrel for the enforcement subdomain within the review context.
 *
 * Exports enforcement types, state management, extraction helpers,
 * and the core four-level integrity enforcement logic.
 *
 * @version v1
 */

export type {
  ReviewableTool,
  PendingReviewTool,
  SubagentRecord,
  ContentMeta,
  CapturedFindings,
  PendingReview,
  SessionEnforcementState,
  TaskToolContext,
  EnforcementResult,
  HostTaskBindOutcome,
  HostTaskBindResult,
} from './types.js';

export {
  REVIEW_REQUIRED_PREFIX,
  REVIEWER_SUBAGENT_TYPE,
  MIN_SUBAGENT_PROMPT_LENGTH,
} from './types.js';

export {
  extractContentMeta,
  extractCapturedFindings,
  promptContainsValue,
  resolveSessionIdFromMetadata,
  injectSessionIdIntoOutput,
  extractSubagentSessionId,
  extractJsonBlock,
} from './extraction.js';

export {
  createSessionState,
  onFlowGuardToolAfter,
  enforceBeforeSubagentCall,
  onTaskToolAfter,
  matchPendingReview,
  enforceBeforeVerdict,
  recordPluginReview,
} from './enforcement.js';
