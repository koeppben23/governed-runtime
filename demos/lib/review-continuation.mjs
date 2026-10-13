/**
 * @module demos/lib/review-continuation
 * @description State-driven plan-gate continuation for the demo runners.
 *
 * Transport recovery (same frozen obligation), bound-verdict submission and a
 * regular revision after a consumed `changes_requested` are DIFFERENT legal
 * continuations. `review_exhausted` is a governed terminal outcome, never an
 * override. Continuations are bounded host turns and must prove persisted
 * review progress (obligation, findings, iteration, completion), not just any
 * state digest change.
 *
 * @version v1
 */

export const PLAN_GATE = Object.freeze({
  ACCEPTED: 'reviewer_accepted',
  REVIEW_EXHAUSTED: 'review_exhausted',
  SUBMIT_BOUND_VERDICT: 'submit_bound_verdict',
  TRANSPORT_RETRY: 'transport_retry',
  REVISE_PLAN: 'revise_plan',
  STALLED: 'stalled',
  UNREADABLE: 'unreadable',
});

function openPlanObligation(state) {
  const obligations = state?.reviewAssurance?.obligations;
  if (!Array.isArray(obligations)) return null;
  return (
    [...obligations]
      .reverse()
      .find(
        (obligation) =>
          obligation?.obligationType === 'plan' &&
          (obligation.status === 'pending' || obligation.status === 'fulfilled') &&
          obligation.consumedAt == null,
      ) ?? null
  );
}

function invocationsFor(state, obligation) {
  const invocations = state?.reviewAssurance?.invocations;
  if (!Array.isArray(invocations)) return [];
  return invocations.filter((invocation) => invocation?.obligationId === obligation.obligationId);
}

/**
 * A bound verdict is a persisted host-orchestrated invocation for the CURRENT
 * obligation (linked by `obligation.invocationId` or already fulfilled). This
 * never relies on findings counters, which can carry stale data across cycles.
 */
export function boundPlanVerdict(state, obligation) {
  const invocations = invocationsFor(state, obligation);
  if (invocations.length === 0) return null;
  if (obligation.invocationId != null) {
    return (
      invocations.find((invocation) => invocation.invocationId === obligation.invocationId) ?? null
    );
  }
  return invocations.find((invocation) => invocation.fulfilledAt != null) ?? null;
}

function latestInvocation(state, obligation) {
  return invocationsFor(state, obligation).at(-1) ?? null;
}

export function classifyPlanGate(state) {
  if (
    !state ||
    typeof state !== 'object' ||
    !state.plan ||
    typeof state.plan !== 'object' ||
    !state.selfReview ||
    typeof state.selfReview !== 'object'
  ) {
    return PLAN_GATE.UNREADABLE;
  }
  if (state.phase !== 'PLAN' && state.phase !== 'PLAN_REVIEW') return PLAN_GATE.UNREADABLE;
  if (state.plan.reviewCompletion === 'reviewer_accepted') return PLAN_GATE.ACCEPTED;
  if (state.plan.reviewCompletion === 'review_exhausted') return PLAN_GATE.REVIEW_EXHAUSTED;
  if (!Number.isInteger(state.selfReview.iteration)) return PLAN_GATE.UNREADABLE;
  if (!Array.isArray(state.plan.reviewFindings)) return PLAN_GATE.UNREADABLE;

  const obligation = openPlanObligation(state);
  if (obligation) {
    if (boundPlanVerdict(state, obligation) !== null) return PLAN_GATE.SUBMIT_BOUND_VERDICT;
    if (obligation.status === 'fulfilled' || obligation.invocationId != null) {
      return PLAN_GATE.UNREADABLE;
    }
    return PLAN_GATE.TRANSPORT_RETRY;
  }
  if (state.phase === 'PLAN') return PLAN_GATE.REVISE_PLAN;
  return PLAN_GATE.UNREADABLE;
}

/**
 * Review-relevant progress fingerprint: obligation identity AND lifecycle
 * (status, invocation link), the latest attempt identity, iteration, findings
 * and completion. Cosmetic or audit-only state changes never count as progress.
 */
export function planGateProgressKey(state) {
  const obligation = openPlanObligation(state);
  const invocation = obligation ? latestInvocation(state, obligation) : null;
  const planVersion = state?.plan?.current?.planVersion ?? '?';
  const findings = Array.isArray(state?.plan?.reviewFindings)
    ? state.plan.reviewFindings.length
    : '?';
  return [
    state?.phase ?? '?',
    state?.plan?.reviewCompletion ?? '?',
    `v${String(planVersion)}`,
    `i${String(state?.selfReview?.iteration ?? '?')}`,
    `f${String(findings)}`,
    `o${String(obligation?.obligationId ?? '-')}:${String(obligation?.status ?? '-')}:${String(
      obligation?.invocationId ?? '-',
    )}:${String(obligation?.consumedAt ?? '-')}`,
    `a${String(invocation?.invocationId ?? '-')}:${String(invocation?.attemptId ?? '-')}`,
  ].join('|');
}

const CONTINUATION_PROMPTS = {
  [PLAN_GATE.SUBMIT_BOUND_VERDICT]:
    'The plan review loop is active and the host already captured the bound independent reviewer ' +
    'verdict. Submit that bound reviewVerdict now through flowguard_plan; for changes_requested ' +
    'include the revised planText and the same claims array. Do not submit an unbound plan and do ' +
    'not withdraw or weaken the retained claim.',
  [PLAN_GATE.TRANSPORT_RETRY]:
    'The reviewer capture failed and the host re-armed a fresh authorized attempt on the same ' +
    'frozen review obligation. Invoke the reviewer Task again immediately for that obligation, ' +
    'then continue the review loop.',
  [PLAN_GATE.REVISE_PLAN]:
    'The independent review returned changes_requested and its obligation is consumed. Address ' +
    'the bound reviewer findings, submit a revised plan through flowguard_plan with planText and ' +
    'the same claims array, and complete the resulting independent review.',
};

/**
 * Drive the persisted plan gate to a classified outcome with at most
 * `maxContinuations` extra host turns. Never approves, never overrides and
 * never raises the review budget.
 */
export async function convergePlanGate({ runner, session, label, maxContinuations = 2 }) {
  for (let attempt = 0; attempt <= maxContinuations; attempt += 1) {
    const state = runner.requireBoundState(session).state;
    const outcome = classifyPlanGate(state);
    if (
      outcome === PLAN_GATE.ACCEPTED ||
      outcome === PLAN_GATE.REVIEW_EXHAUSTED ||
      outcome === PLAN_GATE.UNREADABLE
    ) {
      return { outcome, state };
    }
    if (attempt === maxContinuations) return { outcome: PLAN_GATE.STALLED, state };
    const before = planGateProgressKey(state);
    await runner.turn(
      session,
      `${label}-continuation-${attempt + 1}`,
      CONTINUATION_PROMPTS[outcome],
      {
        command: 'plan',
      },
    );
    const afterState = runner.requireBoundState(session).state;
    if (planGateProgressKey(afterState) === before) {
      return { outcome: PLAN_GATE.STALLED, state: afterState };
    }
  }
  const state = runner.requireBoundState(session).state;
  return { outcome: PLAN_GATE.STALLED, state };
}
