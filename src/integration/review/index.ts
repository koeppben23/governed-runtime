/**
 * @module integration/review
 * @description Public barrel for the review bounded context.
 *
 * This module exports the symbols consumed by plugin-*, tools/, and
 * integration root files. Internal implementation details are NOT
 * re-exported — consumers must use this barrel as the single entry point.
 *
 * Architecture: review/ is a cohesive bounded context that owns:
 * - Review obligation lifecycle and tool mapping
 * - Obligation state transforms (updateObligation, blockObligation)
 * - Enforcement types, pending-review state, and the host-observed
 *   structured-invocation verdict gate
 * - Reviewer subagent orchestration (SDK invocation, retry, output parsing)
 * - Review assurance state management (obligations, invocations, evidence)
 * - Durable dispatch authorization and SDK invocation evidence recording
 * - Prompt construction for all review types
 * - Agent resolution (registry probe + cache)
 * - Findings JSON Schema definition
 * - Review audit event emission
 *
 * Dependency direction: review/ depends on state/, shared/, templates/,
 * config/, and adapters/persistence (audit trail I/O).
 * review/ MUST NOT import from plugin-*, tools/, or integration root.
 *
 * @version v3
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type { OrchestratorClient } from './types.js';

// ─── Enforcement Types ───────────────────────────────────────────────────────

export type {
  ReviewableTool,
  PendingReviewTool,
  PendingReview,
  SessionEnforcementState,
  EnforcementResult,
} from './enforcement/types.js';

export { REVIEW_REQUIRED_PREFIX } from './enforcement/types.js';

// ─── Obligation Tools ────────────────────────────────────────────────────────

export { isReviewableTool, obligationTypeForTool, REVIEWABLE_TOOLS } from './obligation-tools.js';

// ─── Enforcement Logic ───────────────────────────────────────────────────────

export {
  createSessionState,
  onFlowGuardToolAfter,
  enforceBeforeVerdict,
} from './enforcement/enforcement.js';

// ─── Assurance ───────────────────────────────────────────────────────────────

export {
  hashText,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  emptyReviewAssurance,
  ensureReviewAssurance,
  createReviewObligation,
  appendReviewObligation,
  reviewObligationResponseFields,
  findLatestObligation,
  findLatestPendingReviewObligation,
  findReviewObligationById,
  findLatestUnconsumedObligation,
  consumeReviewObligation,
  findAcceptedInvocationForFindings,
  hashFindings,
  buildInvocationEvidence,
  hasEvidenceReuse,
  appendInvocationEvidence,
} from './assurance.js';

// ─── Orchestrator ────────────────────────────────────────────────────────────

export type {
  ReviewerBlockedResult,
  ReviewerSuccessResult,
  ReviewerResult,
  OrchestrationResult,
  InvokeReviewerOptions,
} from './orchestrator.js';

export {
  REVIEW_COMPLETED_PREFIX,
  retrySleep,
  invokeReviewer,
  buildMutatedOutput,
  buildReviewContentMutatedOutput,
  isReviewRequired,
  extractReviewContext,
} from './orchestrator.js';

// ─── Prompt Builders ─────────────────────────────────────────────────────────

export type {
  PlanReviewPromptOpts,
  ImplReviewPromptOpts,
  ArchitectureReviewPromptOpts,
} from './prompt-builders.js';

export {
  selectReviewerProfileRules,
  buildPlanReviewPrompt,
  buildImplReviewPrompt,
  buildArchitectureReviewPrompt,
  buildReviewContentPrompt,
} from './prompt-builders.js';

// ─── Agent Resolution ────────────────────────────────────────────────────────

export {
  REVIEWER_AGENT_PRIMARY,
  ReviewerAgentUnavailableError,
  resolveReviewerAgent,
  _resetAgentResolutionCache,
} from './agent-resolution.js';

// ─── Findings Schema ─────────────────────────────────────────────────────────

export { REVIEW_FINDINGS_JSON_SCHEMA } from './findings-schema.js';

// ─── Obligation State ────────────────────────────────────────────────────────

export { updateObligation, blockObligation } from './obligation-state.js';

// ─── Audit Events ────────────────────────────────────────────────────────────

export { appendReviewAuditEvent } from './audit-events.js';
