/**
 * @module integration/status/next-action-projection.test
 * @description Read-only native next-action projection over canonical status.
 */

import { describe, expect, it } from 'vitest';

import { getPolicyPreset } from '../../config/policy.js';
import { FIXED_TIME, makeProgressedState, makeState } from '../../fixtures.js';
import { projectNextActionResult } from './next-action-projection.js';

const team = getPolicyPreset('team');

function gateState() {
  const state = makeProgressedState('PLAN_REVIEW');
  return {
    ...state,
    reviewAssurance: {
      ...state.reviewAssurance!,
      obligations: state.reviewAssurance!.obligations.map((obligation) => ({
        ...obligation,
        status: 'fulfilled' as const,
        consumedAt: null,
      })),
    },
  };
}

describe('next-action RPC projection', () => {
  it('projects CHOOSE_FLOW with the three canonical actions and a durable state digest', () => {
    const state = makeState('READY');
    const view = projectNextActionResult(state, team);

    expect(view).toMatchObject({
      schemaVersion: 'next-action.v1',
      kind: 'choose_flow',
      sessionID: state.binding.hostSessionId,
      phase: 'READY',
      title: 'Choose a workflow',
      question: 'Choose one workflow to start. Nothing runs until you send a command.',
      blocker: null,
    });
    expect(view.actions.map((action) => action.invocation)).toEqual([
      '/task',
      '/architecture',
      '/review',
    ]);
    expect(view.actions[0]?.visibility).toBe('available');
    expect(view.stateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(view.policyDigest).toBe(state.policySnapshot?.hash);
  });

  it('carries the activation identity when supplied by the canonical authority', () => {
    const view = projectNextActionResult(makeState('READY'), team, {
      activationId: '11111111-1111-4111-8111-111111111111',
      generation: 3,
    });

    expect(view.activationId).toBe('11111111-1111-4111-8111-111111111111');
    expect(view.activationGeneration).toBe(3);
  });

  it('preserves canonical blockers and never projects chooser actions', () => {
    const state = makeState('READY', {
      error: {
        code: 'NEXT_ACTION_TEST_BLOCK',
        message: 'The environment is not usable.',
        recoveryHint: 'Fix the environment.',
        occurredAt: FIXED_TIME,
      },
    });

    const view = projectNextActionResult(state, team);

    expect(view.kind).toBe('blocked');
    expect(view.actions).toEqual([]);
    expect(view.blocker).toMatchObject({
      code: 'NEXT_ACTION_TEST_BLOCK',
      message: 'The environment is not usable.',
    });
  });

  it('maps system work and terminal positions without inventing actions', () => {
    const system = projectNextActionResult(makeProgressedState('PLAN'), team);
    expect(system.kind).toBe('system_work');
    expect(system.actions).toEqual([]);

    const terminal = projectNextActionResult(makeProgressedState('COMPLETE'), team);
    expect(terminal.kind).toBe('terminal');
    expect(terminal.actions).toEqual([]);
  });

  it('projects the exact review decision binding at a human gate', () => {
    const state = gateState();
    const view = projectNextActionResult(state, team, {
      activationId: '11111111-1111-4111-8111-111111111111',
      generation: 4,
    });

    expect(view.kind).toBe('decision_required');
    expect(view.decisionBinding).toMatchObject({
      sessionID: state.binding.hostSessionId,
      activationId: '11111111-1111-4111-8111-111111111111',
      activationGeneration: 4,
      phase: 'PLAN_REVIEW',
      reviewType: 'plan',
    });
    expect(view.decisionBinding?.obligationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('preserves the exhausted override decision set', () => {
    const state = makeProgressedState('PLAN_REVIEW');
    const exhausted = {
      ...state,
      plan: { ...state.plan!, reviewCompletion: 'review_exhausted' as const },
    };

    const view = projectNextActionResult(exhausted, team);

    expect(view.kind).toBe('decision_required');
    expect(view.actions.map((action) => action.invocation)).toEqual([
      '/override-approve',
      '/request-changes',
      '/reject',
    ]);
  });
});
