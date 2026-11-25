/** Classify recoverable transcript outcomes without granting workflow authority. */
import fs from 'node:fs';
import path from 'node:path';
import { sameTurnRecoveryProofs, toolDenialCodes } from '../lib/transcript.mjs';
import { PLAN_GATE, classifyPlanGate } from '../lib/review-continuation.mjs';
import { planReviewCorrectionProven } from './live-plan-preflight.mjs';
import { REPO } from './live-matrix-setup.mjs';
/**
 * Reviewer capture/consistency blocks. The product fail-closed is correct, but
 * a positive proof that never reaches its gate is NOT_VERIFIED, not a demo
 * contract violation. The evidence is preserved either way.
 */
export const REVIEW_STAGE_INCOMPLETE_CODES = new Set([
  'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
  'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
  'SUBAGENT_UNABLE_TO_REVIEW',
  'SUBAGENT_FINDINGS_VERDICT_MISMATCH',
  'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
  'REVIEW_EVIDENCE_NOT_OBSERVED',
  'REVIEW_ATTEMPT_UNAVAILABLE',
  'REVIEWER_STEP_BUDGET_EXHAUSTED',
  'REVIEWER_OUTPUT_TRUNCATED',
  'REVIEWER_TASK_INCOMPLETE',
  'REVIEWER_TASK_ABORTED',
  'REVIEWER_COMPLETION_UNVERIFIABLE',
]);

export function classifyUnexpectedBlock(codes) {
  if (codes.length > 0 && codes.every((code) => REVIEW_STAGE_INCOMPLETE_CODES.has(code))) {
    return 'not_verified';
  }
  return 'failed';
}

/** The persisted review loop ended without reviewer acceptance. */
export function persistedReviewExhausted(state) {
  return (
    state?.plan?.reviewCompletion === 'review_exhausted' ||
    state?.architecture?.reviewCompletion === 'review_exhausted'
  );
}
/**
 * Typed, recoverable denials the governed agent is expected to recover from
 * in-session (fail-fast admission, call-shape corrections). Run 8/9 evidence
 * shows these occur on normal successful flows; they are recorded but do not
 * stop the flow. Every other denial stays flow-stopping.
 */
export const DENIAL_BASELINE = JSON.parse(
  fs.readFileSync(path.join(REPO, 'demos/risk-trigger-fixture/expected-denials.json'), 'utf8'),
);
export const RECOVERABLE_DENIAL_CODES = new Set(DENIAL_BASELINE.recoverable);

/**
 * Recoverable denials whose correction is NOT a same-turn retry of the denied
 * tool but the immediately following explicit runner step. `CONTINUE_AMBIGUOUS`
 * is an admissibility signal that mutates nothing and demands an explicit flow
 * choice; the runner's next step performs exactly that. Such a denial is recorded
 * as `pending_recovery` and only becomes `recovered` when the next required step
 * completes with a demonstrable state transition. There is no blanket allowance:
 * without that proof the flow is blocked.
 */
export const NEXT_STEP_RECOVERY_CODES = new Set(['CONTINUE_AMBIGUOUS']);

/**
 * A plan submission during an ACTIVE review loop is corrected by resuming the
 * bound review in the same turn. The correction is never accepted as a bare
 * retry: the same-turn proof here is paired with the persisted gate proof
 * ({@link planReviewCorrectionProven}) before the flow may continue to the
 * plan approval step.
 */
export const PLAN_REVIEW_CORRECTION_CODE = 'PLAN_REVIEW_IN_PROGRESS';

/**
 * Bounded resume budget for an author that ends the /implement turn at
 * IMPL_REVIEW without the reviewer dispatch. Each resume is a canonical
 * /implement command turn and must prove state progress; the evidence gate is
 * never bypassed and the independent review is never weakened.
 */
export const MAX_IMPLEMENT_REVIEW_RESUMES = 2;

/** Same-turn proof: the planner was denied and then succeeded later in the turn. */
export function planReviewSameTurnCorrection(output) {
  const proof = sameTurnRecoveryProofs(output).recovered.find(
    (candidate) => candidate.code === PLAN_REVIEW_CORRECTION_CODE,
  );
  return proof?.tool === 'flowguard_plan';
}

/**
 * A structured re-arm credits recovery only when the persisted authority proves
 * a FRESH attempt: the re-armed attempt must exist under the same obligation
 * with status `created` (awaiting the reviewer Task) or `bound` (it carried a
 * review). A retryable envelope that references a spent/stale attempt (observed
 * live) is an observation only and never proves recovery.
 */
/**
 * Classify one authorized retry envelope against the persisted re-arm lineage.
 * A re-arm is authorized exactly once per freshly minted `dispatch_rearm`
 * attempt. If that attempt is stale by the time the turn ends, it was still a
 * valid authorization; it FAILED later. Only unknown attempts, foreign
 * obligations, non-rearm origins, or replayed envelopes are stale/unknown.
 */
export function classifyRearmEvent(event, state, seenAttemptIds) {
  const assurance = state?.reviewAssurance;
  const obligation = (assurance?.obligations ?? []).find(
    (item) => item.obligationId === event.obligationId,
  );
  if (!obligation) return { kind: 'stale', reason: 'obligation_unknown' };
  const attempt = (assurance?.attempts ?? []).find((item) => item.attemptId === event.attemptId);
  if (!attempt || attempt.obligationId !== event.obligationId) {
    return { kind: 'stale', reason: 'attempt_unknown' };
  }
  if (attempt.origin?.kind !== 'dispatch_rearm') {
    return { kind: 'stale', reason: 'not_rearm_origin' };
  }
  if (seenAttemptIds?.has(event.attemptId) === true) {
    return { kind: 'stale', reason: 'rearm_already_observed' };
  }
  seenAttemptIds?.add(event.attemptId);
  return { kind: 'authorized', attempt };
}

/**
 * Advance one structured re-arm observation to `rearm_proven` (attempt bound)
 * or `rearm_attempt_failed` (attempt staled after its authorization). The
 * failed record keeps the child session, the denial that ended the attempt, and
 * the capture/obligation state. Returns true when it changed the observation.
 */
export function settleRearmObservation(observation, state, options = {}) {
  const attempts = state?.reviewAssurance?.attempts ?? [];
  const obligations = state?.reviewAssurance?.obligations ?? [];
  const events = Array.isArray(observation.events) ? observation.events : [];
  const denials = Array.isArray(options.denials) ? options.denials : [];
  let changed = false;
  for (const event of events) {
    const attempt = attempts.find(
      (item) =>
        item.attemptId === event.attemptId && item.obligationId === observation.obligationId,
    );
    if (!attempt) continue;
    if (attempt.status === 'bound') {
      observation.status = 'proven';
      observation.lifecycle = 'rearm_proven';
      observation.provenStep = options.label;
      observation.provenBy = 'attempt_bound';
      changed = true;
      continue;
    }
    if (attempt.status !== 'stale') continue;
    const candidates =
      observation.step === options.step
        ? denials.filter(
            (denial) => denial.index > (event.index ?? -1) && denial.code !== event.code,
          )
        : denials.filter((denial) => denial.code !== event.code);
    const obligation = obligations.find((item) => item.obligationId === observation.obligationId);
    observation.status = 'failed';
    observation.lifecycle = 'rearm_attempt_failed';
    observation.failedStep = options.label;
    observation.failureCode = candidates[0]?.code ?? obligation?.blockedCode ?? null;
    observation.childSessionId = attempt.childSessionId ?? observation.childSessionId ?? null;
    observation.captureStatus = 'attempt_stale';
    observation.obligationStatus = obligation?.status ?? null;
    changed = true;
  }
  return changed;
}

/**
 * Terminal decision for a tracked same-turn `PLAN_REVIEW_IN_PROGRESS`
 * correction at the next expected PLAN_REVIEW step. A governed review
 * exhaustion is a NOT_VERIFIED outcome (never a raw harness crash); proven
 * acceptance continues; an unreadable or still-open gate stays blocked.
 */
export function planCorrectionGateDecision(state) {
  if (classifyPlanGate(state) === PLAN_GATE.REVIEW_EXHAUSTED) return 'review_exhausted';
  return planReviewCorrectionProven(state) ? 'proven' : 'blocked';
}

/** Recoverable-family denial: corrected in-session or by the required next step. */
export function isRecoverableFamily(code) {
  return RECOVERABLE_DENIAL_CODES.has(code) || NEXT_STEP_RECOVERY_CODES.has(code);
}

/**
 * True when the most recent host turn produced NO tool call at all AND left
 * the persisted state byte-identical. That is a model/host no-op, not a
 * product denial or a failed tool call: the positive proof is NOT_VERIFIED
 * instead of FAILED. Any observed tool activity or state change keeps the
 * strict FAILED classification.
 */
export function hostTurnWasNoOp(lastTurn, label) {
  return (
    typeof lastTurn === 'object' &&
    lastTurn !== null &&
    lastTurn.label === label &&
    lastTurn.toolCalls === 0 &&
    lastTurn.stateObserved === true &&
    lastTurn.stateChanged === false
  );
}

/** Denials observed in a step that must stop the flow (never recovered in-session). */
export function unexpectedDenialCodes(output) {
  return toolDenialCodes(output).filter((code) => !isRecoverableFamily(code));
}
