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
 * - Enforcement types, state, and validation (4-level integrity)
 * - Reviewer subagent orchestration (SDK invocation, retry, output parsing)
 * - Review assurance state management (obligations, invocations, evidence)
 * - Evidence binding (host-task -> invocation evidence)
 * - Prompt construction for all review types
 * - Agent resolution (registry probe + cache)
 * - Text/JSON extraction from unstructured responses
 * - Findings JSON Schema definition
 * - Review audit event emission
 *
 * Dependency direction: review/ depends on state/, shared/, templates/,
 * config/, and adapters/persistence (audit trail I/O).
 * review/ MUST NOT import from plugin-*, tools/, or integration root.
 *
 * @version v2
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type { OrchestratorClient } from './types.js';

// ─── Enforcement Types ───────────────────────────────────────────────────────

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
} from './enforcement/types.js';

export {
  REVIEW_REQUIRED_PREFIX,
  REVIEWER_SUBAGENT_TYPE,
  MIN_SUBAGENT_PROMPT_LENGTH,
} from './enforcement/types.js';

// ─── Obligation Tools ────────────────────────────────────────────────────────

export { isReviewableTool, obligationTypeForTool, REVIEWABLE_TOOLS } from './obligation-tools.js';

// ─── Enforcement Logic ───────────────────────────────────────────────────────

export {
  createSessionState,
  onFlowGuardToolAfter,
  enforceBeforeSubagentCall,
  onTaskToolAfter,
  matchPendingReview,
  enforceBeforeVerdict,
  recordPluginReview,
} from './enforcement/enforcement.js';

// ─── Enforcement Extraction ──────────────────────────────────────────────────

export {
  extractContentMeta,
  extractCapturedFindings,
  promptContainsValue,
  resolveSessionIdFromMetadata,
  injectSessionIdIntoOutput,
  extractSubagentSessionId,
  extractJsonBlock,
} from './enforcement/extraction.js';

// ─── Assurance ───────────────────────────────────────────────────────────────

export {
  hashText,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  getReviewMandateDigest,
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
  REVIEWER_AGENT_FALLBACK,
  REVIEWER_SYSTEM_DIRECTIVE,
  resolveReviewerAgent,
  _resetAgentResolutionCache,
  _getModelCapabilityCache,
} from './agent-resolution.js';

// ─── Evidence Binding ────────────────────────────────────────────────────────

export { buildHostTaskEvidence } from './evidence-binding.js';

// ─── Text Extraction ─────────────────────────────────────────────────────────

export { extractJsonFromText, extractJsonFromTextWithMethod } from './text-extraction.js';

// ─── Findings Schema ─────────────────────────────────────────────────────────

export { REVIEW_FINDINGS_JSON_SCHEMA } from './findings-schema.js';

// ─── Obligation State ────────────────────────────────────────────────────────

export { updateObligation, blockObligation } from './obligation-state.js';

// ─── Audit Events ────────────────────────────────────────────────────────────

export { appendReviewAuditEvent } from './audit-events.js';
