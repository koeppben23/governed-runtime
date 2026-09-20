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
 * - Reviewer result DTO for the visible native Task transport
 * - Review assurance state management (obligations, invocations, evidence)
 * - Durable dispatch authorization and reviewer evidence recording
 * - Prompt construction for all review types
 * - Agent resolution (registry probe + cache)
 * - Findings JSON Schema definition
 * - Review audit event emission
 *
 * Dependency direction (default-deny): review/ may import review/**,
 * integration root authorities (blocked-result, audit-outbox, errors,
 * tool-names, ...), and the explicit lower layers (adapters, audit, config,
 * discovery, logging, machine, presentation, shared, state, templates).
 * review/ MUST NOT import plugin-*, tools/**, the composition barrels
 * (index.ts, plugin.ts), host-runtime wiring, or sibling integration contexts.
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

// ─── Dispatch Signal ─────────────────────────────────────────────────────────

export type { ReviewDispatchSignal } from './dispatch-signal.js';

export {
  reviewDispatchCompleted,
  readReviewDispatch,
  isReviewDispatchRequired,
  isReviewDispatchCompleted,
} from './dispatch-signal.js';

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

// ─── Dispatch Authority ──────────────────────────────────────────────────────

export type {
  ReviewDispatchAuthority,
  ReviewDispatchAuthorityResult,
} from './dispatch-authority.js';

export {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from './dispatch-authority.js';

// ─── Reviewer Result DTO ─────────────────────────────────────────────────────

export type { ReviewerSuccessResult } from './types.js';

// ─── Prompt Builders ─────────────────────────────────────────────────────────

export type {
  PlanReviewPromptOpts,
  ImplReviewPromptOpts,
  ArchitectureReviewPromptOpts,
} from './prompt-builders.js';

export {
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
