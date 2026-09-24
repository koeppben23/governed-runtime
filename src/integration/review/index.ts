/**
 * @module integration/review
 * @description Public bounded-context facade for review.
 *
 * `review/index.ts` is a composition surface, not an internal hub: it may
 * compose every review subzone, but it MUST NOT be imported by FlowGuard
 * production code — internal code imports the concrete authority it needs.
 * Both properties are enforced by `architecture/__tests__/review-zone-policy`.
 * Symbols consumed by plugin-*, tools/, and integration root files are exposed
 * here for those external callers.
 *
 * Implementation authorities live in the review subzones (`dispatch/`,
 * `obligations/`, `context/`, `observations/`, `evidence/`, `validation/`,
 * `prompting/`, `enforcement/`); the review root keeps only cross-zone
 * primitives. Subzones do not carry their own barrels.
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
 * tool-names, ...), and the frozen lower layers (adapters, config, shared,
 * state, templates). Non-frozen authorities are consumed through injected
 * structural ports (`discovery-port.ts`, `review-logger-port.ts`, the
 * convergence predicate, `ReviewerProofGraphAuthorities`, the machine
 * terminal-phase predicate). review/ MUST NOT import plugin-*, tools/**, the
 * composition barrels (index.ts, plugin.ts), host-runtime wiring, sibling
 * integration contexts, or any other top-level layer.
 *
 * @version v3
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type {
  OrchestratorClient,
  PendingReview,
  PendingReviewTool,
  ReviewVerificationEvidenceItem,
  ReviewableTool,
  SessionEnforcementState,
} from './types.js';

// ─── Enforcement Types ───────────────────────────────────────────────────────

export type { EnforcementResult } from './enforcement/types.js';

// ─── Dispatch Signal ─────────────────────────────────────────────────────────

export type { ReviewDispatchSignal } from './enforcement/dispatch-signal.js';

export {
  reviewDispatchCompleted,
  readReviewDispatch,
  isReviewDispatchRequired,
  isReviewDispatchCompleted,
} from './enforcement/dispatch-signal.js';

// ─── Obligation Tools ────────────────────────────────────────────────────────

export {
  isReviewableTool,
  obligationTypeForTool,
  REVIEWABLE_TOOLS,
} from './obligations/obligation-tools.js';

// ─── Enforcement Logic ───────────────────────────────────────────────────────

export {
  createSessionState,
  onFlowGuardToolAfter,
  enforceBeforeVerdict,
} from './enforcement/enforcement.js';

// ─── Assurance ───────────────────────────────────────────────────────────────

export { hashText } from '../../shared/hashing.js';
export { emptyReviewAssurance, ensureReviewAssurance } from '../../state/review-dispatch.js';
export { hashFindings } from './findings-hash.js';

export {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  createReviewObligation,
  appendReviewObligation,
  findLatestObligation,
  findLatestPendingReviewObligation,
  findReviewObligationById,
  findLatestUnconsumedObligation,
  consumeReviewObligation,
  findAcceptedInvocationForFindings,
  buildInvocationEvidence,
  hasEvidenceReuse,
  appendInvocationEvidence,
} from './obligations/assurance.js';

// ─── Dispatch Authority ──────────────────────────────────────────────────────

export type {
  ReviewDispatchAuthority,
  ReviewDispatchAuthorityResult,
} from './dispatch/dispatch-authority.js';

export {
  resolveReviewDispatchAuthority,
  reviewObligationResponseFields,
} from './dispatch/dispatch-authority.js';

// ─── Reviewer Result DTO ─────────────────────────────────────────────────────

export type { ReviewerSuccessResult } from './types.js';

// ─── Prompt Builders ─────────────────────────────────────────────────────────

export type {
  PlanReviewPromptOpts,
  ImplReviewPromptOpts,
  ArchitectureReviewPromptOpts,
} from './prompting/prompt-builders.js';

export {
  buildPlanReviewPrompt,
  buildImplReviewPrompt,
  buildArchitectureReviewPrompt,
  buildReviewContentPrompt,
} from './prompting/prompt-builders.js';

// ─── Agent Resolution ────────────────────────────────────────────────────────

export {
  REVIEWER_AGENT_PRIMARY,
  ReviewerAgentUnavailableError,
  resolveReviewerAgent,
  _resetAgentResolutionCache,
} from './dispatch/agent-resolution.js';

// ─── Findings Schema ─────────────────────────────────────────────────────────

export { REVIEW_FINDINGS_JSON_SCHEMA } from './evidence/findings-schema.js';

// ─── Obligation State ────────────────────────────────────────────────────────

export { updateObligation, blockObligation } from './obligations/obligation-state.js';

// ─── Audit Events ────────────────────────────────────────────────────────────

export { appendReviewAuditEvent } from './evidence/audit-events.js';
