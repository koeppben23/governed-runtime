/**
 * @module integration/review/enforcement/enforce-before-verdict.test
 * @description L1 (binary gate): a verdict is only authorized by a host-observed
 * structured reviewer invocation bound to the SPECIFIC pending obligation —
 * never by the mere existence of any SDK invocation in the session.
 */

import { describe, expect, it } from 'vitest';
import {
  createSessionState,
  enforceBeforeVerdict,
  onFlowGuardToolAfter as rawOnFlowGuardToolAfter,
} from './enforcement.js';
import { reviewDispatchRequired } from '../dispatch/dispatch-signal.js';
import { NOW } from './test-helpers.js';
import { buildInvocationEvidence, ensureReviewAssurance, hashText } from '../assurance.js';
import { makeState } from '../../../fixtures.js';
import type { ReviewInvocationEvidence } from '../../../state/evidence.js';

const OBLIGATION_A = '11111111-1111-4111-8111-1111111111a1';
const OBLIGATION_B = '11111111-1111-4111-8111-1111111111b2';
const ATTEMPT_A = '22222222-2222-4222-8222-2222222222a1';
const ATTEMPT_B = '22222222-2222-4222-8222-2222222222b2';

function invocation(input: {
  obligationId: string;
  attemptId: string;
  childSessionId?: string;
}): ReviewInvocationEvidence {
  return buildInvocationEvidence({
    obligationId: input.obligationId,
    obligationType: 'plan',
    mandateDigest: 'mandate-digest',
    criteriaVersion: 'criteria-v1',
    parentSessionId: 'parent-session-1',
    childSessionId: input.childSessionId ?? 'child-session-1',
    promptHash: hashText('prompt'),
    findingsHash: hashText('findings'),
    invokedAt: NOW,
    fulfilledAt: NOW,
    attemptId: input.attemptId,
    capturedRawFindings: { overallVerdict: 'accept' },
  });
}

function stateWith(invocations: readonly ReviewInvocationEvidence[]) {
  return makeState('PLAN_REVIEW', {
    reviewAssurance: { ...ensureReviewAssurance(undefined), invocations: [...invocations] },
  });
}

function pendingState(attemptId: string | null, obligationId: string | null) {
  const state = createSessionState();
  state.pendingReviews.set('flowguard_plan', {
    tool: 'flowguard_plan',
    requestedAt: NOW,
    attemptId,
    obligationId,
  });
  return state;
}

import { isTerminalPhase } from '../../../machine/topology.js';

type ToolAfterArgs = Parameters<typeof rawOnFlowGuardToolAfter>;

function onFlowGuardToolAfter(
  state: ToolAfterArgs[0],
  toolName: ToolAfterArgs[1],
  args: ToolAfterArgs[2],
  output: ToolAfterArgs[3],
  now: string,
): ReturnType<typeof rawOnFlowGuardToolAfter> {
  return rawOnFlowGuardToolAfter(state, toolName, args, output, {
    now,
    isTerminalPhase,
  });
}

describe('enforceBeforeVerdict — obligation/attempt-bound L1 gate', () => {
  it('HAPPY: allows the verdict when the invocation is bound to the pending obligation and attempt', () => {
    const result = enforceBeforeVerdict(
      pendingState(ATTEMPT_A, OBLIGATION_A),
      'flowguard_plan',
      { reviewVerdict: 'accept' },
      stateWith([invocation({ obligationId: OBLIGATION_A, attemptId: ATTEMPT_A })]),
    );
    expect(result).toEqual({ allowed: true });
  });

  it('BAD: an invocation for a DIFFERENT obligation does not authorize the verdict', () => {
    const result = enforceBeforeVerdict(
      pendingState(ATTEMPT_A, OBLIGATION_A),
      'flowguard_plan',
      { reviewVerdict: 'accept' },
      stateWith([invocation({ obligationId: OBLIGATION_B, attemptId: ATTEMPT_A })]),
    );
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');
  });

  it('BAD: an invocation bound to a different attempt does not authorize the verdict', () => {
    const result = enforceBeforeVerdict(
      pendingState(ATTEMPT_A, OBLIGATION_A),
      'flowguard_plan',
      { reviewVerdict: 'accept' },
      stateWith([invocation({ obligationId: OBLIGATION_A, attemptId: ATTEMPT_B })]),
    );
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');
  });

  it('BAD: a signal without an attempt identity cannot authorize a verdict', () => {
    const result = enforceBeforeVerdict(
      pendingState(null, OBLIGATION_A),
      'flowguard_plan',
      { reviewVerdict: 'accept' },
      stateWith([invocation({ obligationId: OBLIGATION_A, attemptId: ATTEMPT_A })]),
    );
    expect(result).toMatchObject({ allowed: false, code: 'SUBAGENT_REVIEW_NOT_INVOKED' });
  });

  it('BAD: a pending signal without an obligation identity fails closed', () => {
    const result = enforceBeforeVerdict(
      pendingState(ATTEMPT_A, null),
      'flowguard_plan',
      { reviewVerdict: 'accept' },
      stateWith([invocation({ obligationId: OBLIGATION_A, attemptId: ATTEMPT_A })]),
    );
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');
  });

  it('BAD: no invocation at all fails closed', () => {
    const result = enforceBeforeVerdict(
      pendingState(ATTEMPT_A, OBLIGATION_A),
      'flowguard_plan',
      { reviewVerdict: 'accept' },
      stateWith([]),
    );
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');
  });

  it('EDGE: an unrelated session verdict is allowed when no review is pending', () => {
    const result = enforceBeforeVerdict(
      createSessionState(),
      'flowguard_plan',
      { reviewVerdict: 'accept' },
      stateWith([invocation({ obligationId: OBLIGATION_B, attemptId: ATTEMPT_B })]),
    );
    expect(result).toEqual({ allowed: true });
  });

  it('SIGNAL: tracking records the obligation and attempt identities of the requirement', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      {},
      JSON.stringify({
        reviewDispatch: reviewDispatchRequired(),
        reviewObligation: { obligationId: OBLIGATION_A },
        reviewAttemptId: ATTEMPT_A,
      }),
      NOW,
    );
    expect(state.pendingReviews.get('flowguard_plan')).toMatchObject({
      attemptId: ATTEMPT_A,
      obligationId: OBLIGATION_A,
    });
  });

  it('SIGNAL: a dispatch requirement without the attempt identity fails closed', () => {
    const state = createSessionState();
    const result = onFlowGuardToolAfter(
      state,
      'flowguard_plan',
      {},
      JSON.stringify({
        reviewDispatch: reviewDispatchRequired(),
        reviewObligation: { obligationId: OBLIGATION_A },
      }),
      NOW,
    );
    expect(result).toMatchObject({
      kind: 'nonconforming',
      code: 'REVIEW_ATTEMPT_UNAVAILABLE',
      obligationId: OBLIGATION_A,
    });
    expect(state.pendingReviews.size).toBe(0);
  });

  it('SIGNAL: a peer review dispatch requirement without the attempt identity fails closed', () => {
    const state = createSessionState();
    const result = onFlowGuardToolAfter(
      state,
      'flowguard_review',
      {},
      JSON.stringify({
        error: true,
        code: 'CONTENT_ANALYSIS_REQUIRED',
        reviewDispatch: reviewDispatchRequired(),
        reviewObligation: { obligationId: OBLIGATION_B },
      }),
      NOW,
    );
    expect(result).toMatchObject({
      kind: 'nonconforming',
      code: 'REVIEW_ATTEMPT_UNAVAILABLE',
      obligationId: OBLIGATION_B,
    });
    expect(state.pendingReviews.size).toBe(0);
  });

  it('SIGNAL: the peer review dispatch records the authority identity', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(
      state,
      'flowguard_review',
      {},
      JSON.stringify({
        error: true,
        code: 'CONTENT_ANALYSIS_REQUIRED',
        reviewDispatch: reviewDispatchRequired(),
        reviewObligation: { obligationId: OBLIGATION_B },
        reviewAttemptId: ATTEMPT_B,
      }),
      NOW,
    );
    expect(state.pendingReviews.get('flowguard_review')).toMatchObject({
      obligationId: OBLIGATION_B,
    });
  });
});
