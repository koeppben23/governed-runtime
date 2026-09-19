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
} from './evidence-review-assurance-refinements.js';

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

/** Attempt ordinals are unique per obligation and the initial attempt is the lowest ordinal. */
function hasCoherentOrdinals(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): boolean {
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
      return false;
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
        return false;
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
      return false;
    }
  }
  return true;
}

function hasCoherentLifecycleFields(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): boolean {
  for (const attempt of assurance.attempts) {
    if (attempt.status === 'created') {
      if (attempt.completedAt || attempt.rejectionReason) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attempts'],
          message: `created attempt ${attempt.attemptId} must not carry completion or rejection fields`,
        });
        return false;
      }
      continue;
    }
    if (!attempt.completedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `${attempt.status} attempt ${attempt.attemptId} is missing completedAt`,
      });
      return false;
    }
    if (attempt.status !== 'rejected' && attempt.rejectionReason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: `attempt ${attempt.attemptId} carries rejection fields without a rejected status`,
      });
      return false;
    }
  }
  return true;
}

function addAttemptIssue(context: z.RefinementCtx, message: string): false {
  context.addIssue({ code: z.ZodIssueCode.custom, path: ['attempts'], message });
  return false;
}

/** Predecessor obligation/subject identity and strict ordering. */
function predecessorCoherenceError(
  attempt: AttemptRefinementShape,
  predecessor: AttemptRefinementShape,
): string | null {
  if (
    predecessor.obligationId !== attempt.obligationId ||
    predecessor.obligationType !== attempt.obligationType ||
    predecessor.subjectDigest !== attempt.subjectDigest
  ) {
    return `attempt ${attempt.attemptId} predecessor ${predecessor.attemptId} belongs to a different obligation`;
  }
  if (predecessor.ordinal >= attempt.ordinal || predecessor.createdAt > attempt.createdAt) {
    return `attempt ${attempt.attemptId} predecessor ${predecessor.attemptId} is not an earlier attempt`;
  }
  return null;
}

/** Trigger reason coherence against the predecessor's durable release record. */
function triggerReasonCoherenceError(
  attempt: AttemptRefinementShape,
  origin: AttemptRefinementShape['origin'],
  predecessor: AttemptRefinementShape,
  dispatches: AssuranceRefinementShape['dispatches'],
): string | null {
  const expectedTriggers = triggerReasonsForPredecessor(origin.kind, predecessor, dispatches);
  if (
    expectedTriggers === null ||
    origin.triggerReason === undefined ||
    !expectedTriggers.includes(origin.triggerReason)
  ) {
    return `attempt ${attempt.attemptId} trigger reason does not match its predecessor state`;
  }
  return null;
}

/**
 * Non-initial origins (`dispatch_rearm`) are authority-bearing: the referenced
 * predecessor must exist, belong to the same obligation/subject, be a STRICTLY
 * earlier attempt, and the trigger reason must be coherent with the
 * predecessor's durable release record.
 */
function hasCoherentPredecessorLineage(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): boolean {
  const attemptsById = new Map(assurance.attempts.map((attempt) => [attempt.attemptId, attempt]));
  for (const attempt of assurance.attempts) {
    const origin = attempt.origin;
    if (origin.kind === 'initial') continue;
    const predecessorId = origin.predecessorAttemptId;
    if (!predecessorId) {
      return addAttemptIssue(
        context,
        `attempt ${attempt.attemptId} has a non-initial origin without a predecessor`,
      );
    }
    const predecessor = attemptsById.get(predecessorId);
    if (!predecessor) {
      return addAttemptIssue(
        context,
        `attempt ${attempt.attemptId} references unknown predecessor ${predecessorId}`,
      );
    }
    const coherenceError = predecessorCoherenceError(attempt, predecessor);
    if (coherenceError) return addAttemptIssue(context, coherenceError);
    const triggerError = triggerReasonCoherenceError(
      attempt,
      origin,
      predecessor,
      assurance.dispatches,
    );
    if (triggerError) return addAttemptIssue(context, triggerError);
  }
  return true;
}

/**
 * Attempt predecessor lineage. Non-initial origins (`dispatch_rearm`) are
 * authority-bearing: the referenced predecessor must exist, belong to the same
 * obligation/subject, be a STRICTLY earlier attempt, and the trigger reason
 * must be coherent with the predecessor's durable release record. Attempt
 * ordinals are unique per obligation.
 */
export function refineAssuranceAttemptLineageCoherence(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  if (!hasCoherentOrdinals(assurance, context)) return;
  if (!hasCoherentLifecycleFields(assurance, context)) return;
  if (!hasCoherentPredecessorLineage(assurance, context)) return;
}

function triggerReasonsForPredecessor(
  originKind: string,
  predecessor: AttemptRefinementShape,
  dispatches: AssuranceRefinementShape['dispatches'],
): readonly string[] | null {
  if (originKind !== 'dispatch_rearm') return null;
  if (predecessor.status !== 'created' && predecessor.status !== 'stale') return null;
  const released = dispatches.filter((record) => record.attemptId === predecessor.attemptId);
  if (predecessor.status === 'created') {
    if (released.some((record) => record.dispatchStatus === 'authorized')) return ['interrupted'];
    if (released.some((record) => record.dispatchStatus === 'outcome_unknown')) return ['spent'];
    return null;
  }
  // Minting a re-arm stales its created predecessor and converts the release to
  // outcome_unknown. That durable record proves recovery but no longer retains
  // whether the pre-mint trigger was interrupted or already spent.
  if (released.some((record) => record.dispatchStatus === 'outcome_unknown')) {
    return ['interrupted', 'spent'];
  }
  return null;
}

type InvocationRefinementShape = AssuranceRefinementShape['invocations'][number];
type DispatchRefinementShape = AssuranceRefinementShape['dispatches'][number];

function dispatchLinksInvocation(
  dispatch: DispatchRefinementShape,
  invocation: InvocationRefinementShape,
): boolean {
  return (
    dispatch.attemptId === invocation.attemptId &&
    dispatch.obligationId === invocation.obligationId &&
    dispatch.hostCallId === invocation.childSessionId &&
    dispatch.canonicalPromptDigest === invocation.promptHash
  );
}

function groupByAttemptId<T>(
  items: readonly T[],
  attemptIdOf: (item: T) => string | undefined,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = attemptIdOf(item) ?? '';
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  }
  return grouped;
}

/** Every invocation requires exactly one completed dispatch for its release identity. */
function validateInvocationDispatchLinks(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
  dispatchesByAttempt: ReadonlyMap<string, DispatchRefinementShape[]>,
): boolean {
  for (const invocation of assurance.invocations) {
    const dispatches = dispatchesByAttempt.get(invocation.attemptId ?? '') ?? [];
    const matches = dispatches.filter(
      (dispatch) =>
        dispatchLinksInvocation(dispatch, invocation) &&
        dispatch.dispatchStatus === 'completed' &&
        dispatch.completedAt != null,
    );
    if (matches.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocations'],
        message: `invocation ${invocation.invocationId} requires exactly one completed dispatch for its attempt, host call, and prompt digest (found ${String(matches.length)})`,
      });
      return false;
    }
  }
  return true;
}

/** A completed dispatch requires exactly one invocation; a pending dispatch requires none. */
function validateDispatchInvocationLinks(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
  invocationsByAttempt: ReadonlyMap<string, InvocationRefinementShape[]>,
): boolean {
  for (const dispatch of assurance.dispatches) {
    const matches = (invocationsByAttempt.get(dispatch.attemptId) ?? []).filter((invocation) =>
      dispatchLinksInvocation(dispatch, invocation),
    );
    if (dispatch.dispatchStatus === 'completed' && matches.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispatches'],
        message: `completed dispatch ${dispatch.dispatchId} requires exactly one matching invocation (found ${String(matches.length)})`,
      });
      return false;
    }
    if (dispatch.dispatchStatus !== 'completed' && matches.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispatches'],
        message: `dispatch ${dispatch.dispatchId} is ${dispatch.dispatchStatus} but has a matching invocation`,
      });
      return false;
    }
  }
  return true;
}

/** Durable dispatch and invocation evidence must describe the same host release. */
export function refineAssuranceInvocationDispatchLinkage(
  assurance: AssuranceRefinementShape,
  context: z.RefinementCtx,
): void {
  const dispatchesByAttempt = groupByAttemptId(
    assurance.dispatches,
    (dispatch) => dispatch.attemptId,
  );
  const invocationsByAttempt = groupByAttemptId(
    assurance.invocations,
    (invocation) => invocation.attemptId,
  );
  if (!validateInvocationDispatchLinks(assurance, context, dispatchesByAttempt)) return;
  if (!validateDispatchInvocationLinks(assurance, context, invocationsByAttempt)) return;
}
