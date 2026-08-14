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
import { isPendingCaptureUsable } from './prepare-findings.js';
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
 * Dispatch authority is the DURABLE attempt lifecycle, never the transient
 * capture: a Task call may run only when its pending review names a durable
 * attempt that is still `created` (bindable, no child session). A rejected,
 * bound, staled, or expired attempt is never re-dispatched by a bare Task
 * call — only the originating FlowGuard command re-issues an attempt
 * (canonical output repair) and emits a fresh signal first.
 *
 * The transient capture is consulted only when NO durable assurance is
 * available to the gate (legacy fallback for callers without state access).
 */
function isDispatchable(
  pending: PendingReview,
  assurance: ReviewAssuranceState | null | undefined,
): boolean {
  const namesAttempt = pending.obligationId != null && pending.attemptId != null;
  if (assurance && namesAttempt) {
    const durable = assurance.attempts.find(
      (a) => a.obligationId === pending.obligationId && a.attemptId === pending.attemptId,
    );
    return durable !== undefined && durable.status === 'created' && !durable.childSessionId;
  }
  if (pending.subagentCalled === false) return true;
  if (!assurance) return !isPendingCaptureUsable(pending);
  return false;
}

/**
 * With durable authority, a pending review without a bindable attempt is NOT
 * dispatchable: a bare Task call must never re-arm a rejected attempt. Only
 * the originating FlowGuard command re-issues attempts.
 */
function notDispatchableBlock(
  state: SessionEnforcementState,
  assurance: ReviewAssuranceState | null | undefined,
): EnforcementResult | null {
  if (!assurance || state.pendingReviews.size === 0) return null;
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
  strictEnforcement = false,
  assurance?: ReviewAssuranceState | null,
): EnforcementResult {
  const subagentType = typeof taskArgs.subagent_type === 'string' ? taskArgs.subagent_type : '';
  if (subagentType !== REVIEWER_SUBAGENT_TYPE) return { allowed: true };

  const prompt = typeof taskArgs.prompt === 'string' ? taskArgs.prompt : '';

  const structuralBlock = structuralContextBlock(state);
  if (structuralBlock) return structuralBlock;

  // Include pending reviews dispatchable against a durable bindable attempt.
  const unfilledPendingReviews = [...state.pendingReviews.values()].filter((p) =>
    isDispatchable(p, assurance),
  );
  if (unfilledPendingReviews.length === 0) {
    return notDispatchableBlock(state, assurance) ?? { allowed: true };
  }

  return enforcePendingReviewPrompt(unfilledPendingReviews, prompt, strictEnforcement);
}

function enforcePendingReviewPrompt(
  unfilledPendingReviews: PendingReview[],
  prompt: string,
  strictEnforcement: boolean,
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

  // Check repair-prompt requirement: after schema-invalid output, a
  // fresh canonical repair prompt must be issued by flowguard_review.
  // Validation uses a host-issued opaque SHA256 digest — the parent
  // cannot fabricate the exact repair prompt bytes.
  const needsRepair = unfilledPendingReviews.filter((p) => p.repairPromptRequired);
  if (needsRepair.length > 0) {
    // A repair prompt must have been issued (expectedRepairPromptDigest set)
    // AND the task prompt must match its digest exactly.
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
    // Note: repairPromptRequired is cleared in onTaskToolAfter after the
    // task runs — never in this pre-execution validator (fail-closed).
  }

  return null;
}

/**
 * Verify that the host-issued canonical prompt includes the artifact.
 *
 * The length floor and the iteration/planVersion match are all satisfied by the
 * canonical prompt's instruction block alone, so without this check a reviewer
 * could be dispatched with nothing to review and every enforcement level would
 * still report success.
 *
 * Only applies where FlowGuard actually emitted a canonical prompt; a legitimate
 * host-issued prompt is unaffected.
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
