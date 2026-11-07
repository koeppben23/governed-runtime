/**
 * @module integration/status/decision-binding.test
 * @description Exact review-subject and activation binding for native decisions.
 */

import { describe, expect, it } from 'vitest';

import { makeProgressedState } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';
import { checkDecisionBinding, projectDecisionBinding } from './decision-binding.js';

const ACTIVATION = {
  activationId: '11111111-1111-4111-8111-111111111111',
  generation: 2,
};

/** The shipped review fixtures are post-decision; reopen their obligation for gate projection. */
function planGateState(): SessionState {
  const state = makeProgressedState('PLAN_REVIEW');
  return {
    ...state,
    reviewAssurance: {
      ...state.reviewAssurance!,
      obligations: state.reviewAssurance!.obligations.map(
        (obligation: NonNullable<SessionState['reviewAssurance']>['obligations'][number]) => ({
          ...obligation,
          status: 'fulfilled' as const,
          consumedAt: null,
        }),
      ),
    },
  };
}

describe('native decision binding', () => {
  it('projects the current gate obligation and reviewed subject', () => {
    const state = planGateState();
    const binding = projectDecisionBinding(state, ACTIVATION);

    expect(binding).not.toBeNull();
    expect(binding).toMatchObject({
      sessionID: state.binding.hostSessionId,
      activationId: ACTIVATION.activationId,
      activationGeneration: 2,
      policyDigest: state.policySnapshot?.hash,
      phase: 'PLAN_REVIEW',
      reviewType: 'plan',
    });
    expect(binding?.obligationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(binding?.subjectDigest.length).toBeGreaterThan(0);
  });

  it('has no decision binding outside a review gate', () => {
    expect(projectDecisionBinding(makeProgressedState('READY'), ACTIVATION)).toBeNull();
  });

  it('accepts the unchanged displayed binding', () => {
    const state = planGateState();
    const binding = projectDecisionBinding(state, ACTIVATION)!;

    expect(checkDecisionBinding(binding, state, ACTIVATION)).toEqual({ kind: 'ok' });
  });

  it('refuses a changed activation identity or generation', () => {
    const state = planGateState();
    const binding = projectDecisionBinding(state, ACTIVATION)!;

    expect(
      checkDecisionBinding(
        { ...binding, activationId: '22222222-2222-4222-8222-222222222222' },
        state,
        ACTIVATION,
      ),
    ).toMatchObject({ kind: 'blocked', code: 'DECISION_BINDING_STALE' });
    expect(
      checkDecisionBinding({ ...binding, activationGeneration: 3 }, state, ACTIVATION),
    ).toMatchObject({ kind: 'blocked', code: 'DECISION_BINDING_STALE' });
  });

  it('refuses a changed workflow state or policy digest', () => {
    const state = planGateState();
    const binding = projectDecisionBinding(state, ACTIVATION)!;

    expect(
      checkDecisionBinding({ ...binding, stateDigest: 'f'.repeat(64) }, state, ACTIVATION),
    ).toMatchObject({ kind: 'blocked', code: 'DECISION_BINDING_STALE' });
    expect(
      checkDecisionBinding({ ...binding, policyDigest: 'f'.repeat(64) }, state, ACTIVATION),
    ).toMatchObject({ kind: 'blocked', code: 'DECISION_BINDING_STALE' });
  });

  it('refuses a different obligation or reviewed subject revision', () => {
    const state = planGateState();
    const binding = projectDecisionBinding(state, ACTIVATION)!;

    expect(
      checkDecisionBinding(
        { ...binding, obligationId: '33333333-3333-4333-8333-333333333333' },
        state,
        ACTIVATION,
      ),
    ).toMatchObject({ kind: 'blocked', code: 'DECISION_BINDING_STALE' });
    expect(
      checkDecisionBinding({ ...binding, subjectDigest: 'd'.repeat(64) }, state, ACTIVATION),
    ).toMatchObject({ kind: 'blocked', code: 'DECISION_BINDING_STALE' });
  });
});
