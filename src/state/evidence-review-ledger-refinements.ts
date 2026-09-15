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
 * Attempt predecessor lineage. Non-initial origins (`dispatch_rearm`) are
 * authority-bearing: the referenced predecessor must exist, belong to the same
 * obligation/subject, be a STRICTLY earlier attempt, and the trigger reason
 * must be coherent with the predecessor's terminal state AND durable release
 * record. Attempt ordinals are unique per obligation.
 */
export function refineAssuranceAttemptLineageCoherence(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  const attemptsById = new Map(assurance.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const ordinals = new Set<string>();
  const minOrdinalByObligation = new Map<string, number>();
  const initialByObligation = new Map<string, AttemptRefinementShape>();
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
    const min = minOrdinalByObligation.get(attempt.obligationId);
    minOrdinalByObligation.set(
      attempt.obligationId,
      min === undefined ? attempt.ordinal : Math.min(min, attempt.ordinal),
    );
    if (attempt.origin.kind === 'initial') {
      if (initialByObligation.has(attempt.obligationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attempts'],
          message: `obligation ${attempt.obligationId} has more than one initial attempt`,
        });
        return;
      }
      initialByObligation.set(attempt.obligationId, attempt);
    }
  }
  for (const [obligationId, initial] of initialByObligation) {
    if (initial.ordinal !== minOrdinalByObligation.get(obligationId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `initial attempt ${initial.attemptId} is not the lowest-ordinal attempt for obligation ${obligationId}`,
      });
      return;
    }
  }
  for (const attempt of assurance.attempts) {
    if (attempt.status === 'created') {
      if (attempt.completedAt || attempt.rejectionReason) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attempts'],
          message: `created attempt ${attempt.attemptId} must not carry completion or rejection fields`,
        });
        return;
      }
      continue;
    }
    if (!attempt.completedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `${attempt.status} attempt ${attempt.attemptId} is missing completedAt`,
      });
      return;
    }
    if (attempt.status !== 'rejected' && attempt.rejectionReason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `attempt ${attempt.attemptId} carries rejection fields without a rejected status`,
      });
      return;
    }
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
    const expectedTriggers = triggerReasonsForPredecessor(
      origin.kind,
      predecessor,
      assurance.dispatches,
    );
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
  dispatches: AssuranceRefinementShape['dispatches'],
): readonly string[] | null {
  if (originKind !== 'dispatch_rearm') return null;
  if (predecessor.status === 'created') {
    const released = dispatches.filter((record) => record.attemptId === predecessor.attemptId);
    if (released.some((record) => record.dispatchStatus === 'authorized')) return ['interrupted'];
    if (released.some((record) => record.dispatchStatus === 'outcome_unknown')) return ['spent'];
    return null;
  }
  // A `created` predecessor is superseded to `stale` by the re-arm mint, so
  // the interrupted, spent, and already-stale triggers are all coherent for a
  // stale predecessor.
  if (predecessor.status === 'stale') return ['interrupted', 'spent', 'stale'];
  if (predecessor.status === 'rejected') return ['rejected'];
  if (predecessor.status === 'expired') return ['expired'];
  return null;
}
