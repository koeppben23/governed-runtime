/** Project plan-preflight recovery onto the current independently accepted gate. */
import { expectRecovery } from '../lib/recovery-state.mjs';
import {
  eventsOf,
  operationIdentity,
  toolDenialEvents,
  toolUseEvents,
} from '../lib/transcript.mjs';

export const PLAN_PREFLIGHT_RECOVERY_CODES = new Set([
  'PLAN_EVIDENCE_DESIGN_REQUIRED',
  'PLAN_EVIDENCE_DESIGN_INVALID',
  'PLAN_FINDING_RESOLUTION_REQUIRED',
  'PLAN_FINDING_RESOLUTION_INVALID',
  'PLAN_CLAIM_LINEAGE_REQUIRED',
  'PLAN_CLAIM_LINEAGE_INVALID',
  'REVIEW_SUBJECT_CHANGED_WHILE_PENDING',
  'PLAN_CLAIM_SUBMISSION_REJECTED',
]);

/** A recorded reviewer acceptance with a consistent iteration. */
export function planReviewCorrectionProven(state) {
  const plan = state.plan;
  const selfReview = state.selfReview;
  if (!plan || !selfReview) return false;
  const iterationConsistent =
    Number.isInteger(selfReview.iteration) &&
    Number.isInteger(selfReview.maxIterations) &&
    selfReview.iteration <= selfReview.maxIterations;
  return (
    plan.reviewCompletion === 'reviewer_accepted' &&
    selfReview.verdict === 'accept' &&
    iterationConsistent
  );
}

/** Freeze the bound gate reached by this turn; a later, unrelated gate cannot settle it. */
export function planPreflightGate(state, sessionId, validateInvocation, denials = []) {
  if (
    state?.phase !== 'PLAN_REVIEW' ||
    state.binding?.hostSessionId !== sessionId ||
    !state.flowguardSessionId ||
    !planReviewCorrectionProven(state)
  )
    return null;
  const gate = expectRecovery(
    state,
    ['flowguard_plan'],
    undefined,
    denials,
    0,
    [],
    validateInvocation,
  );
  return gate.kind === 'subject_approval' &&
    /^[a-f0-9]{64}$/.test(gate.digest) &&
    /^[a-f0-9]{64}$/.test(gate.recordDigest) &&
    Number.isInteger(gate.planVersion) &&
    gate.planVersion > 0
    ? gate
    : null;
}

export function pendingPlanPreflight(
  output,
  step,
  state,
  sessionId,
  phaseBefore,
  validateInvocation,
) {
  const denials = toolDenialEvents(output).filter((event) =>
    PLAN_PREFLIGHT_RECOVERY_CODES.has(event.code),
  );
  if (denials.length === 0) return null;
  const calls = toolUseEvents(output).filter((event) => event.tool === 'flowguard_plan');
  const last = calls.at(-1);
  const response = last?.payload.value;
  const events = eventsOf(output);
  const afterDenials = denials.every(
    (event) =>
      event.tool === 'flowguard_plan' &&
      events[event.index - 1]?.sessionID === sessionId &&
      event.index < last?.index,
  );
  const identities = denials.map((event) =>
    operationIdentity(calls.find((call) => call.index === event.index)?.payload),
  );
  const gate =
    phaseBefore !== 'PLAN_REVIEW' &&
    afterDenials &&
    events[last.index - 1]?.sessionID === sessionId &&
    response?.error !== true &&
    response?.phase === 'PLAN_REVIEW' &&
    response.planDigest === state?.plan?.current?.digest
      ? planPreflightGate(state, sessionId, validateInvocation, identities)
      : null;
  return {
    status: 'pending_verification',
    step,
    codes: [...new Set(denials.map((event) => event.code))],
    evidence: 'same_turn_plan_preflight_correction',
    gate,
  };
}
