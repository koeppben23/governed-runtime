/**
 * @module integration/status/status-choose-flow.test
 * @description Canonical portable CHOOSE_FLOW projection across /status and /help.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, expect, it } from 'vitest';

import { getPolicyPreset } from '../../config/policy.js';
import { FIXED_TIME, makeProgressedState, makeState } from '../../fixtures.js';
import { renderMarkdown } from '../../presentation/index.js';
import {
  WORKFLOW_CHOICE_ACTIONS,
  WORKFLOW_CHOICE_QUESTION,
} from '../../presentation/workflow-choice.js';
import { notCheckedDiscoveryDriftStatus } from '../discovery/discovery-drift-status.js';
import { buildHelpResult } from '../help/help-projection.js';
import { renderHelp } from '../help/help-renderer.js';
import { buildStatusProjection } from './status.js';
import { buildBlockedProjection } from './status-detail-projections.js';
import { buildStatusDocument } from './status-presentation.js';
import { buildFinishCard } from './status-finish.js';
import {
  buildFinishPresentationProjection,
  buildWhyPresentationProjection,
} from './status-why-finish.js';

const policy = getPolicyPreset('team');

describe('portable CHOOSE_FLOW projection', () => {
  it('HAPPY — projects exactly the three canonical choices and keeps /task suggested only', () => {
    const state = makeState('READY');
    const before = structuredClone(state);

    const status = buildStatusProjection(state, policy);

    expect(status.directive).toMatchObject({
      kind: 'user_action',
      code: 'CHOOSE_FLOW',
      commands: ['/task', '/architecture', '/review'],
    });
    expect(status.conclusion).toEqual({
      kind: 'decision_required',
      question: WORKFLOW_CHOICE_QUESTION,
      actions: WORKFLOW_CHOICE_ACTIONS,
    });
    expect(status.conclusion.kind).toBe('decision_required');
    if (status.conclusion.kind !== 'decision_required') throw new Error('expected a decision');
    expect(status.conclusion.actions.map((action) => action.invocation)).toEqual([
      '/task',
      '/architecture',
      '/review',
    ]);
    expect(status.conclusion.actions[0]?.description).toContain('recommended');
    expect(status.conclusion.actions[0]?.visibility).toBe('available');
    expect(state).toEqual(before);
  });

  it('HAPPY — status Markdown renders all three choices as one decision', () => {
    const status = buildStatusProjection(makeState('READY'), policy);
    const document = buildStatusDocument(
      {
        status,
        discoveryHealth: null,
        discoveryDrift: notCheckedDiscoveryDriftStatus('CHOOSE_FLOW presentation test.'),
      },
      { detail: 'summary' },
    );

    expect(document.kind).toBe('compact_card');
    if (document.kind === 'compact_card') expect(document.form).toBe('decision');
    const markdown = renderMarkdown(document);
    expect(markdown).toContain(WORKFLOW_CHOICE_QUESTION);
    for (const invocation of ['/task', '/architecture', '/review']) {
      expect(markdown).toContain(invocation);
    }
    expect(markdown).toContain('Nothing runs until you send a command');
  });

  it('HAPPY — /why and /finish use the same chooser decision', () => {
    const state = makeState('READY');
    const expected = {
      kind: 'decision_required',
      question: WORKFLOW_CHOICE_QUESTION,
      actions: WORKFLOW_CHOICE_ACTIONS,
    };

    const why = buildWhyPresentationProjection(
      state,
      policy,
      buildBlockedProjection(state, policy),
    );
    expect(why.conclusion).toEqual(expected);

    const finish = buildFinishPresentationProjection(state, buildFinishCard(state, policy));
    expect(finish.conclusion).toEqual(expected);
  });

  it('HAPPY — /help exposes the same chooser and marks only /task recommended', () => {
    const help = buildHelpResult(makeState('READY'), policy, { view: 'context' });

    expect(help.directive).toBeNull();
    expect(help.nextActionSummary).toContain('/task');
    expect(help.nextActionSummary).toContain('/architecture');
    expect(help.nextActionSummary).toContain('/review');
    expect(help.commands.find((command) => command.invocation === '/task')?.visibility).toBe(
      'recommended',
    );
    const markdown = renderHelp(help, { format: 'markdown' });
    expect(markdown).toContain('## Next');
    expect(markdown).toContain('/task');
    expect(markdown).toContain('/architecture');
    expect(markdown).toContain('/review');
  });

  it('BAD — a canonical blocker wins over the READY chooser projection', () => {
    const blocked = makeState('READY', {
      error: {
        code: 'CHOOSER_TEST_BLOCK',
        message: 'The environment is not usable.',
        recoveryHint: 'Fix the environment.',
        occurredAt: FIXED_TIME,
      },
    });

    const status = buildStatusProjection(blocked, policy);

    expect(status.directive).toMatchObject({ kind: 'blocked', code: 'WORKFLOW_BLOCKED' });
    expect(status.conclusion.kind).toBe('recovery');
    expect(JSON.stringify(status.conclusion)).not.toContain('/task');
    expect(JSON.stringify(status.conclusion)).not.toContain('/architecture');
    expect(JSON.stringify(status.conclusion)).not.toContain('/review');
  });

  it('CORNER — does not project the chooser outside CHOOSE_FLOW', () => {
    const ticket = buildStatusProjection(makeProgressedState('TICKET'), policy);
    expect(ticket.conclusion).toMatchObject({
      kind: 'next_action',
      action: { invocation: '/plan' },
    });

    const plan = buildStatusProjection(makeProgressedState('PLAN'), policy);
    expect(plan.conclusion.kind).toBe('review_pending');

    const complete = buildStatusProjection(makeProgressedState('COMPLETE'), policy);
    expect(complete.conclusion.kind).toBe('terminal');
  });

  it('EDGE — exhausted review gates keep the override decision set', () => {
    const state = makeProgressedState('PLAN_REVIEW');
    const exhausted = {
      ...state,
      plan: { ...state.plan!, reviewCompletion: 'review_exhausted' as const },
    };

    const status = buildStatusProjection(exhausted, policy);

    expect(status.conclusion.kind).toBe('decision_required');
    if (status.conclusion.kind !== 'decision_required') throw new Error('expected a decision');
    expect(status.conclusion.actions.map((action) => action.invocation)).toEqual([
      '/override-approve',
      '/request-changes',
      '/reject',
    ]);
    expect(status.conclusion.actions.map((action) => action.invocation)).not.toContain('/approve');
  });
});
