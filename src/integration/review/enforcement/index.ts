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
  EnforcementResult,
  HostTaskBindOutcome,
  HostTaskBindResult,
} from './types.js';

export { REVIEW_REQUIRED_PREFIX } from './types.js';

export { signalAttestationOf, readHostAttestationConstants } from './extraction.js';

export {
  createSessionState,
  onFlowGuardToolAfter,
  enforceBeforeVerdict,
  recordPluginReview,
} from './enforcement.js';
