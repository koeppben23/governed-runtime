/**
 * @module integration/status/next-action-projection.test
 * @description Read-only native next-action projection over canonical status.
 */

import { describe, expect, it } from 'vitest';

import { getPolicyPreset } from '../../config/policy.js';
import { FIXED_TIME, makeProgressedState, makeState } from '../../fixtures.js';
import { projectNextActionResult } from './next-action-projection.js';

const team = getPolicyPreset('team');

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
