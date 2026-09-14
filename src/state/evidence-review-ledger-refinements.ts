/**
 * @module evidence-review-ledger-refinements
 * @description Cross-record coherence for the attempt lineage and the durable
 *              dispatch ledger of the current review-assurance generation.
 *
 * Attempt origins and dispatches are authority-bearing: predecessors must be
 * real, same-obligation, strictly earlier attempts with a coherent trigger,
 * and each host call must close at most one dispatch.
 */

import { z } from 'zod';
import type {
  AssuranceRefinementShape,
  AttemptRefinementShape,
} from './evidence-review-refinements.js';

/**
 * Dispatch-ledger referential closure. The durable dispatch ledger is
 * authority-bearing, so every dispatch must reference an EXISTING attempt
 * belonging to the SAME obligation, and dispatch identities must be unique.
 * Orphans and cross-links are invalid states, not legacy data.
 */
export function refineAssuranceDispatchCoherence(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  const attemptsById = new Map(assurance.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const dispatchIds = new Set<string>();
  const hostCallIds = new Set<string>();
  const activeAttemptDispatches = new Set<string>();
  for (const dispatch of assurance.dispatches) {
    if (dispatchIds.has(dispatch.dispatchId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispatches'],
        message: `duplicate dispatchId ${dispatch.dispatchId} — a dispatch identity must be unique across the assurance state`,
      });
      return;
    }
    dispatchIds.add(dispatch.dispatchId);
    if (hostCallIds.has(dispatch.hostCallId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispatches'],
        message: `duplicate hostCallId ${dispatch.hostCallId} — one host call can close at most one dispatch`,
      });
      return;
    }
    hostCallIds.add(dispatch.hostCallId);
    const attempt = attemptsById.get(dispatch.attemptId);
    if (!attempt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispatches'],
        message: `dispatch ${dispatch.dispatchId} references unknown attempt ${dispatch.attemptId}`,
      });
      return;
    }
    if (attempt.obligationId !== dispatch.obligationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispatches'],
        message: `dispatch ${dispatch.dispatchId} obligation does not match its attempt`,
      });
      return;
    }
    if (dispatch.dispatchStatus !== 'outcome_unknown') {
      if (activeAttemptDispatches.has(dispatch.attemptId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dispatches'],
          message: `attempt ${dispatch.attemptId} carries more than one active dispatch`,
        });
        return;
      }
      activeAttemptDispatches.add(dispatch.attemptId);
    }
    if (dispatch.dispatchStatus === 'authorized' && dispatch.completedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispatches'],
        message: `dispatch ${dispatch.dispatchId} is authorized but carries completedAt`,
      });
      return;
    }
    if (dispatch.dispatchStatus === 'completed' && !dispatch.completedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispatches'],
        message: `dispatch ${dispatch.dispatchId} is completed but is missing completedAt`,
      });
      return;
    }
  }
}

/**
 * Attempt predecessor lineage. Non-initial origins (`output_repair`,
 * `task_rearm`) are authority-bearing: the referenced predecessor must exist,
 * belong to the same obligation/subject, be a STRICTLY earlier attempt, and the
 * trigger reason must be coherent with the predecessor's terminal state.
 * Attempt ordinals are unique per obligation.
 */
export function refineAssuranceAttemptLineageCoherence(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  const attemptsById = new Map(assurance.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const ordinals = new Set<string>();
  for (const attempt of assurance.attempts) {
    const key = `${attempt.obligationId}#${String(attempt.ordinal)}`;
    if (ordinals.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `duplicate attempt ordinal ${attempt.ordinal} for obligation ${attempt.obligationId}`,
      });
      return;
    }
    ordinals.add(key);
  }
  for (const attempt of assurance.attempts) {
    const origin = attempt.origin;
    if (origin.kind === 'initial') continue;
    const predecessorId = origin.predecessorAttemptId;
    if (!predecessorId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `attempt ${attempt.attemptId} has a non-initial origin without a predecessor`,
      });
      return;
    }
    const predecessor = attemptsById.get(predecessorId);
    if (!predecessor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `attempt ${attempt.attemptId} references unknown predecessor ${predecessorId}`,
      });
      return;
    }
    if (
      predecessor.obligationId !== attempt.obligationId ||
      predecessor.obligationType !== attempt.obligationType ||
      predecessor.subjectDigest !== attempt.subjectDigest
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `attempt ${attempt.attemptId} predecessor ${predecessorId} belongs to a different obligation`,
      });
      return;
    }
    if (predecessor.ordinal >= attempt.ordinal || predecessor.createdAt > attempt.createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `attempt ${attempt.attemptId} predecessor ${predecessorId} is not an earlier attempt`,
      });
      return;
    }
    const expectedTriggers = triggerReasonsForPredecessor(origin.kind, predecessor);
    if (
      expectedTriggers === null ||
      origin.triggerReason === undefined ||
      !expectedTriggers.includes(origin.triggerReason)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `attempt ${attempt.attemptId} trigger reason does not match its predecessor state`,
      });
      return;
    }
  }
}

function triggerReasonsForPredecessor(
  originKind: string,
  predecessor: AttemptRefinementShape,
): readonly string[] | null {
  if (originKind === 'output_repair') {
    return predecessor.status === 'rejected' && predecessor.rejectionReason
      ? [predecessor.rejectionReason]
      : null;
  }
  if (originKind === 'task_rearm') {
    if (predecessor.status === 'created') return ['interrupted'];
    if (predecessor.status === 'rejected') return ['rejected'];
    // A `created` predecessor is superseded to `stale` by the re-arm mint, so
    // both the interrupted and the already-stale triggers are coherent for a
    // stale predecessor.
    if (predecessor.status === 'stale') return ['interrupted', 'stale'];
    if (predecessor.status === 'expired') return ['expired'];
    return null;
  }
  return null;
}
