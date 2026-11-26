/**
 * @module integration/status/decision-binding
 * @description Read-only binding of a displayed review decision to the exact
 * canonical review obligation and subject revision. This module projects
 * existing review-assurance state; it never decides, approves or mutates.
 */

import { z } from 'zod';

import type { Phase, SessionState } from '../../state/schema.js';
import { findLatestReviewObligation } from '../../state/review-continuation.js';
import { computeStateDigest } from '../audit-outbox.js';

const DecisionReviewType = z.enum(['plan', 'architecture', 'implement']);
type DecisionReviewType = z.infer<typeof DecisionReviewType>;

/**
 * Untrusted expected binding carried by a native decision control. The server
 * re-reads every field from canonical state immediately before the decision.
 */
export const DecisionBinding = z
  .object({
    sessionID: z.string().min(1),
    activationId: z.string().uuid(),
    activationGeneration: z.number().int().positive(),
    policyDigest: z.string().min(1),
    stateDigest: z.string().min(1),
    phase: z.string().min(1),
    obligationId: z.string().uuid(),
    subjectDigest: z.string().min(1),
    reviewType: DecisionReviewType,
    reviewCycle: z.number().int().positive().nullable(),
    iteration: z.number().int().nonnegative(),
  })
  .strict();
export type DecisionBinding = z.infer<typeof DecisionBinding>;

const REVIEW_TYPE_BY_PHASE: Readonly<Partial<Record<Phase, DecisionReviewType>>> = {
  PLAN_REVIEW: 'plan',
  ARCH_REVIEW: 'architecture',
  EVIDENCE_REVIEW: 'implement',
};

export interface DecisionBindingActivation {
  readonly activationId: string;
  readonly generation: number;
}

/**
 * Project the active gate's exact obligation and subject. Returns null for
 * non-gate phases, inactive activation, or a gate without a canonical review
 * obligation.
 */
export function projectDecisionBinding(
  state: SessionState,
  activation: DecisionBindingActivation | undefined,
): DecisionBinding | null {
  const reviewType = REVIEW_TYPE_BY_PHASE[state.phase];
  const policyDigest = state.policySnapshot?.hash;
  if (reviewType === undefined || activation === undefined || policyDigest === undefined) {
    return null;
  }
  const obligation = findLatestReviewObligation(
    state.reviewAssurance?.obligations ?? [],
    reviewType,
  );
  if (obligation === undefined) return null;
  return {
    sessionID: state.binding.hostSessionId,
    activationId: activation.activationId,
    activationGeneration: activation.generation,
    policyDigest,
    stateDigest: computeStateDigest(state),
    phase: state.phase,
    obligationId: obligation.obligationId,
    subjectDigest: obligation.subjectDigest,
    reviewType,
    reviewCycle: obligation.reviewCycle,
    iteration: obligation.iteration,
  };
}

export type DecisionBindingCheck =
  | { readonly kind: 'ok' }
  | { readonly kind: 'blocked'; readonly code: 'DECISION_BINDING_STALE'; readonly reason: string };

function stale(reason: string): DecisionBindingCheck {
  return { kind: 'blocked', code: 'DECISION_BINDING_STALE', reason };
}

/**
 * Compare an untrusted displayed binding with the current canonical binding.
 * The comparison is exact; any changed field requires the operator to reopen
 * the view.
 */
export function checkDecisionBinding(
  expected: DecisionBinding,
  state: SessionState,
  activation: DecisionBindingActivation,
): DecisionBindingCheck {
  const simpleMismatch = [
    {
      reason: 'The active session changed.',
      mismatch: expected.sessionID !== state.binding.hostSessionId,
    },
    {
      reason: 'The governance activation changed.',
      mismatch:
        expected.activationId !== activation.activationId ||
        expected.activationGeneration !== activation.generation,
    },
    {
      reason: 'The frozen policy changed.',
      mismatch: expected.policyDigest !== state.policySnapshot?.hash,
    },
    {
      reason: 'The workflow state changed.',
      mismatch: expected.stateDigest !== computeStateDigest(state),
    },
    { reason: 'The workflow phase changed.', mismatch: expected.phase !== state.phase },
  ].find((field) => field.mismatch);
  if (simpleMismatch !== undefined) return stale(simpleMismatch.reason);

  const current = projectDecisionBinding(state, activation);
  if (current === null) {
    return stale('No current review decision is available.');
  }
  if (
    expected.reviewType !== current.reviewType ||
    expected.obligationId !== current.obligationId
  ) {
    return stale('The review obligation changed.');
  }
  if (
    expected.subjectDigest !== current.subjectDigest ||
    expected.reviewCycle !== current.reviewCycle ||
    expected.iteration !== current.iteration
  ) {
    return stale('The reviewed subject changed.');
  }
  return { kind: 'ok' };
}
