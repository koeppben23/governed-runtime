/**
 * @module integration/review/enforcement/prompt-integrity
 * @description Level 3 enforcement: the reviewer Task prompt must carry the
 * review context AND the artifact under review.
 *
 * Extracted from `enforcement.ts` when that file crossed the 750 LOC budget.
 * These checks form one cohesive gate - everything that inspects the prompt
 * before a reviewer subagent is dispatched - and nothing else in enforcement
 * depends on their internals.
 */

import {
  type SessionEnforcementState,
  type PendingReview,
  type EnforcementResult,
  MIN_SUBAGENT_PROMPT_LENGTH,
} from './types.js';
import { promptContainsValue } from './extraction.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../tool-names.js';
import { ReviewFindings } from '../../../state/evidence-review.js';
import { validateReviewFindingsConsistency } from './findings-consistency.js';

/** Inlined from enforcement.ts to avoid circular import. */
function hasUsableCapture(pending: PendingReview): boolean {
  if (pending.subagentRecord?.terminationReason === 'step_exhausted') return false;
  const parsed = ReviewFindings.safeParse(pending.capturedFindings?.rawFindings);
  if (!parsed.success) return false;
  return validateReviewFindingsConsistency({
    overallVerdict: parsed.data.overallVerdict,
    blockingIssueCount: parsed.data.blockingIssues.length,
  }).ok;
}
/**
 * Enforce prompt integrity before allowing a subagent call (Level 3).
 * Called in tool.execute.before for task calls with subagent_type=flowguard-reviewer.
 *
 * Validates:
 * 1. Prompt meets minimum length (catches empty/trivial prompts)
 * 2. Prompt contains expected iteration value (contextual match)
 * 3. Prompt contains expected planVersion value (contextual match, plan only)
 *
 * @param state - Session enforcement state (read-only check)
 * @param taskArgs - Task tool call arguments
 * @returns Enforcement result
 */
function checkReviewContext(
  pendingReviews: PendingReview[],
  prompt: string,
  strictEnforcement: boolean,
): { hasMatch: boolean; missingFields: string[]; blockReason?: EnforcementResult } {
  const missingFields: string[] = [];
  for (const pending of pendingReviews) {
    if (!pending.contentMeta) {
      if (strictEnforcement) {
        return {
          hasMatch: false,
          missingFields,
          blockReason: {
            allowed: false,
            code: 'SUBAGENT_CONTEXT_UNVERIFIABLE',
            reason:
              'Content meta extraction failed — cannot validate subagent context in strict mode. The FlowGuard tool response must include structured review obligation metadata.',
          },
        };
      }
      return { hasMatch: true, missingFields };
    }
    const { expectedIteration, expectedPlanVersion } = pending.contentMeta;
    const hasIteration = promptContainsValue(prompt, 'iteration', expectedIteration);
    const hasPlanVersion =
      expectedPlanVersion === null || promptContainsValue(prompt, 'version', expectedPlanVersion);
    if (hasIteration && hasPlanVersion) return { hasMatch: true, missingFields };
    if (!hasIteration) missingFields.push(`iteration=${expectedIteration}`);
    if (!hasPlanVersion && expectedPlanVersion !== null)
      missingFields.push(`planVersion=${expectedPlanVersion}`);
  }
  return { hasMatch: false, missingFields };
}

export function enforceBeforeSubagentCall(
  state: SessionEnforcementState,
  taskArgs: Record<string, unknown>,
  strictEnforcement = false,
): EnforcementResult {
  const subagentType = typeof taskArgs.subagent_type === 'string' ? taskArgs.subagent_type : '';
  if (subagentType !== REVIEWER_SUBAGENT_TYPE) return { allowed: true };

  const prompt = typeof taskArgs.prompt === 'string' ? taskArgs.prompt : '';
  // Include pending reviews awaiting capture: never called, or called but
  // capture is unusable (schema-invalid) and a retry is still allowed.
  const unfilledPendingReviews = [...state.pendingReviews.values()].filter(
    (p) => !p.subagentCalled || !hasUsableCapture(p),
  );
  if (unfilledPendingReviews.length === 0) return { allowed: true };

  // Check retry exhaustion: a review that was already called and has
  // exhausted its retry budget (>= 1 retry) cannot be re-invoked.
  const retryExhausted = unfilledPendingReviews.filter(
    (p) => p.subagentCalled && (p.retryCount ?? 0) >= 1,
  );
  if (
    retryExhausted.length > 0 &&
    unfilledPendingReviews.every((p) => retryExhausted.includes(p))
  ) {
    return {
      allowed: false,
      code: 'REVIEWER_OUTPUT_RETRY_EXHAUSTED',
      reason:
        `FlowGuard enforcement: the reviewer has already produced schema-invalid ` +
        `output and the retry budget (1 retry) is exhausted. The review cannot ` +
        `proceed — report this to the operator.`,
    };
  }

  if (prompt.length < MIN_SUBAGENT_PROMPT_LENGTH) {
    return {
      allowed: false,
      code: 'SUBAGENT_PROMPT_EMPTY',
      reason: `FlowGuard enforcement: the prompt for ${REVIEWER_SUBAGENT_TYPE} is too short (${prompt.length} chars, minimum ${MIN_SUBAGENT_PROMPT_LENGTH}). Include the plan/implementation text, ticket text, iteration, and planVersion.`,
    };
  }

  const ctx = checkReviewContext(unfilledPendingReviews, prompt, strictEnforcement);
  if (ctx.blockReason) return ctx.blockReason;
  if (!ctx.hasMatch) {
    return {
      allowed: false,
      code: 'SUBAGENT_PROMPT_MISSING_CONTEXT',
      reason: `FlowGuard enforcement: the prompt for ${REVIEWER_SUBAGENT_TYPE} does not contain the expected review context. Missing: ${[...new Set(ctx.missingFields)].join(', ')}. Include the iteration and planVersion values from the FlowGuard tool response.`,
    };
  }
  return checkArtifactAppended(unfilledPendingReviews, prompt);
}

/**
 * Verify that the artifact was appended below the canonical prompt.
 *
 * The length floor and the iteration/planVersion match are all satisfied by the
 * canonical prompt on its own, so without this check a reviewer could be
 * dispatched with the instruction block and nothing to review, and every
 * enforcement level would still report success.
 *
 * Only applies where FlowGuard actually emitted a canonical prompt; a legitimate
 * free-composed prompt is unaffected.
 */
function checkArtifactAppended(
  pendingReviews: readonly PendingReview[],
  prompt: string,
): EnforcementResult {
  for (const pending of pendingReviews) {
    const anchor = pending.canonicalPromptAnchor;
    if (!anchor) continue;
    const at = prompt.lastIndexOf(anchor);
    if (at === -1) continue;
    const appended = prompt.slice(at + anchor.length).trim();
    if (appended.length === 0) {
      return {
        allowed: false,
        code: 'SUBAGENT_PROMPT_ARTIFACT_MISSING',
        reason: `FlowGuard enforcement: the prompt for ${REVIEWER_SUBAGENT_TYPE} ends at the canonical instruction block with no artifact appended below it. Append the content to review (plan text, implementation diff, ADR, or reviewed diff) below that line; a reviewer cannot review an empty subject.`,
      };
    }
  }
  return { allowed: true };
}
