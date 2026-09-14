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

import { createHash } from 'node:crypto';

import {
  type SessionEnforcementState,
  type PendingReview,
  type EnforcementResult,
  MIN_SUBAGENT_PROMPT_LENGTH,
} from './types.js';
import type { ReviewAssuranceState } from '../../../state/evidence.js';
import { promptContainsValue } from './extraction.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../tool-names.js';

/**
 * Enforce prompt integrity before allowing a subagent call (Level 3).
 * Called in tool.execute.before for task calls with subagent_type=flowguard-reviewer.
 */
function checkReviewContext(
  pendingReviews: PendingReview[],
  prompt: string,
): { hasMatch: boolean; missingFields: string[]; blockReason?: EnforcementResult } {
  const missingFields: string[] = [];
  for (const pending of pendingReviews) {
    if (!pending.contentMeta) {
      return {
        hasMatch: false,
        missingFields,
        blockReason: {
          allowed: false,
          code: 'SUBAGENT_CONTEXT_UNVERIFIABLE',
          reason:
            'Content meta extraction failed — cannot validate subagent context. The FlowGuard tool response must include structured review obligation metadata.',
        },
      };
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

/**
 * Structural host-context defect detected at the signal→pending transition:
 * the REVIEW_REQUIRED signal named an obligation without host attestation
 * constants, or named no obligation at all. This is NEVER a reviewer-output
 * failure — no reviewer invocation can repair it, so dispatch is blocked
 * before any retry/repair logic can run. Recovery: re-issue the originating
 * FlowGuard command so a fresh canonical signal replaces the defective
 * pending (see trackRequiredReview).
 */
function structuralContextBlock(state: SessionEnforcementState): EnforcementResult | null {
  const structuralFailure = [...state.pendingReviews.values()].find(
    (p) => (p.enforcementFailure ?? null) !== null,
  );
  if (!structuralFailure) return null;
  return {
    allowed: false,
    code: 'HOST_REVIEW_CONTEXT_UNAVAILABLE',
    reason:
      `FlowGuard enforcement: the canonical review signal for obligation ` +
      `${structuralFailure.obligationId ?? 'unknown'} is structurally incomplete ` +
      `(${structuralFailure.enforcementFailure}) and cannot be repaired by a reviewer invocation. ` +
      `Re-run the originating FlowGuard command to re-issue the canonical review signal ` +
      `carrying requiredReviewAttestation.`,
  };
}

/**
 * Whether a pending review may be dispatched by the reviewer Task RIGHT NOW.
 *
 * Dispatch authority is the DURABLE attempt lifecycle, never transient capture
 * state. A Task call may run only when its pending review names a durable
 * attempt that is still `created` (bindable, no child session). A rejected,
 * bound, staled, or expired attempt is never re-dispatched by a bare Task call.
 */
function isDispatchable(
  pending: PendingReview,
  assurance: ReviewAssuranceState | null | undefined,
): boolean {
  if (!assurance || pending.obligationId == null || pending.attemptId == null) return false;
  const durable = assurance.attempts.find(
    (attempt) =>
      attempt.obligationId === pending.obligationId && attempt.attemptId === pending.attemptId,
  );
  return durable !== undefined && durable.status === 'created' && !durable.childSessionId;
}

/**
 * A pending review without a durable bindable attempt is not dispatchable.
 */
function notDispatchableBlock(state: SessionEnforcementState): EnforcementResult | null {
  if (state.pendingReviews.size === 0) return null;
  return {
    allowed: false,
    code: 'REVIEWER_TASK_NOT_DISPATCHABLE',
    reason:
      'FlowGuard enforcement: no reviewer Task can be dispatched — the review ' +
      'obligation has no durable bindable attempt. Re-run the originating ' +
      'FlowGuard command to authorize a fresh review attempt.',
  };
}

export function enforceBeforeSubagentCall(
  state: SessionEnforcementState,
  taskArgs: Record<string, unknown>,
  assurance?: ReviewAssuranceState | null,
): EnforcementResult {
  const subagentType = typeof taskArgs.subagent_type === 'string' ? taskArgs.subagent_type : '';
  if (subagentType !== REVIEWER_SUBAGENT_TYPE) return { allowed: true };

  const prompt = typeof taskArgs.prompt === 'string' ? taskArgs.prompt : '';

  const structuralBlock = structuralContextBlock(state);
  if (structuralBlock) return structuralBlock;

  const unfilledPendingReviews = [...state.pendingReviews.values()].filter((pending) =>
    isDispatchable(pending, assurance),
  );
  if (unfilledPendingReviews.length === 0) {
    return notDispatchableBlock(state) ?? { allowed: true };
  }

  return enforcePendingReviewPrompt(unfilledPendingReviews, prompt);
}

function enforcePendingReviewPrompt(
  unfilledPendingReviews: PendingReview[],
  prompt: string,
): EnforcementResult {
  const promptDigest = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const canonicalPromptBlock = checkCanonicalPrompt(unfilledPendingReviews, promptDigest);
  if (canonicalPromptBlock) return canonicalPromptBlock;

  if (prompt.length < MIN_SUBAGENT_PROMPT_LENGTH) {
    return {
      allowed: false,
      code: 'SUBAGENT_PROMPT_EMPTY',
      reason: `FlowGuard enforcement: the prompt for ${REVIEWER_SUBAGENT_TYPE} is too short (${prompt.length} chars, minimum ${MIN_SUBAGENT_PROMPT_LENGTH}). Include the plan/implementation text, ticket text, iteration, and planVersion.`,
    };
  }

  const ctx = checkReviewContext(unfilledPendingReviews, prompt);
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

function checkCanonicalPrompt(
  unfilledPendingReviews: PendingReview[],
  promptDigest: string,
): EnforcementResult | null {
  const expectedPrompt = unfilledPendingReviews.find(
    (pending) => pending.expectedPromptDigest !== null,
  );
  const expectedPromptDigest = expectedPrompt?.expectedPromptDigest;
  if (
    expectedPromptDigest !== null &&
    expectedPromptDigest !== undefined &&
    expectedPromptDigest !== promptDigest
  ) {
    return {
      allowed: false,
      code: expectedPrompt!.repairPromptRequired
        ? 'REPAIR_PROMPT_REQUIRED'
        : 'SUBAGENT_PROMPT_MISMATCH',
      reason: expectedPrompt!.repairPromptRequired
        ? 'FlowGuard enforcement: the repair prompt does not exactly match the host-issued bytes.'
        : 'FlowGuard enforcement: the reviewer prompt does not exactly match the host-issued bytes.',
    };
  }

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

  const needsRepair = unfilledPendingReviews.filter((p) => p.repairPromptRequired);
  if (needsRepair.length > 0) {
    const matchesRepair = needsRepair.some(
      (p) => p.expectedRepairPromptDigest !== null && p.expectedRepairPromptDigest === promptDigest,
    );
    if (!matchesRepair) {
      const hasDigest = needsRepair.some((p) => p.expectedRepairPromptDigest !== null);
      return {
        allowed: false,
        code: 'REPAIR_PROMPT_REQUIRED',
        reason: hasDigest
          ? `FlowGuard enforcement: the reviewer produced schema-invalid output. ` +
            `The repair prompt's cryptographic digest does not match. ` +
            `Call flowguard_review to obtain a fresh canonical repair prompt, ` +
            `then invoke Task only with subagent_type="${REVIEWER_SUBAGENT_TYPE}". ` +
            `FlowGuard injects the canonical bytes at the host boundary.`
          : `FlowGuard enforcement: the reviewer produced schema-invalid output. ` +
            `A fresh canonical repair prompt must be obtained from flowguard_review ` +
            `before re-running the reviewer Task. Call flowguard_review first, then invoke ` +
            `a new Task only with subagent_type="${REVIEWER_SUBAGENT_TYPE}"; never reuse ` +
            `a stale prompt.`,
      };
    }
  }

  return null;
}

/**
 * Verify that the host-issued canonical prompt includes the artifact.
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
        reason: `FlowGuard enforcement: the host-issued prompt for ${REVIEWER_SUBAGENT_TYPE} contains no artifact below the canonical instruction block. Reissue the review so FlowGuard can provide reviewable material; a reviewer cannot review an empty subject.`,
      };
    }
  }
  return { allowed: true };
}
