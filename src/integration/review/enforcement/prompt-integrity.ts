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

// eslint-disable-next-line complexity
export function enforceBeforeSubagentCall(
  state: SessionEnforcementState,
  taskArgs: Record<string, unknown>,
  strictEnforcement = false,
): EnforcementResult {
  const subagentType = typeof taskArgs.subagent_type === 'string' ? taskArgs.subagent_type : '';
  if (subagentType !== REVIEWER_SUBAGENT_TYPE) return { allowed: true };

  const prompt = typeof taskArgs.prompt === 'string' ? taskArgs.prompt : '';

  const structuralBlock = structuralContextBlock(state);
  if (structuralBlock) return structuralBlock;

  // Include pending reviews awaiting capture: never called, or called but
  // capture is unusable (schema-invalid) and a retry is still allowed.
  const unfilledPendingReviews = [...state.pendingReviews.values()].filter(
    (p) => !p.subagentCalled || !isPendingCaptureUsable(p),
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

  // Check repair-prompt requirement: after schema-invalid output, a
  // fresh canonical repair prompt must be issued by flowguard_review.
  // Validation uses a host-issued opaque SHA256 digest — the parent
  // cannot fabricate the exact repair prompt bytes.
  const needsRepair = unfilledPendingReviews.filter((p) => p.repairPromptRequired);
  if (needsRepair.length > 0) {
    // A repair prompt must have been issued (expectedRepairPromptDigest set)
    // AND the task prompt must match its digest exactly.
    const promptDigest = createHash('sha256').update(prompt, 'utf8').digest('hex');
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
            `then pass it VERBATIM to the Task tool — do not modify a single byte.`
          : `FlowGuard enforcement: the reviewer produced schema-invalid output. ` +
            `A fresh canonical repair prompt must be obtained from flowguard_review ` +
            `before re-running the reviewer Task. Call flowguard_review first, ` +
            `then use the NEW reviewerTaskPrompt — never reuse the stale one.`,
      };
    }
    // Note: repairPromptRequired is cleared in onTaskToolAfter after the
    // task runs — never in this pre-execution validator (fail-closed).
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
