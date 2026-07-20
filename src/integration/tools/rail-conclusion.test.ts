/**
 * @module integration/tools/rail-conclusion.test
 * @description Unit tests for buildRailConclusion — the rail-surface Next-Action
 *              conclusion projection.
 *
 * @test-policy
 * HAPPY: transition/pending states → next_action with the recommended product command.
 * HAPPY: waiting (user gate) → decision_required with the gate's product commands.
 * HAPPY: terminal COMPLETE → next_action(/export); aborted COMPLETE → next_action(/status).
 * CORNER: aborted terminal never routes to /export.
 * EDGE: fail-closed codes on structurally-empty projections.
 * PERF: not applicable; pure function.
 */
import { describe, it, expect } from 'vitest';
import type { SessionState } from '../../state/schema.js';
import type { EvalResult } from '../../machine/evaluate.js';
import { buildRailConclusion } from './rail-conclusion.js';
import { makeState, makeProgressedState } from '../../fixtures.js';
import { createReviewObligation } from '../review/assurance.js';

function abortedComplete(): SessionState {
  return {
    ...makeProgressedState('COMPLETE'),
    error: {
      code: 'ABORTED',
      message: 'Session aborted by user.',
      recoveryHint: 'Start a new session.',
      occurredAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

describe('buildRailConclusion', () => {
  describe('HAPPY — work remains → next_action', () => {
    it('transition to VALIDATION recommends the product command', () => {
      const state = makeProgressedState('VALIDATION');
      const evalResult: EvalResult = { kind: 'transition', target: 'VALIDATION', event: 'APPROVE' };
      const conclusion = buildRailConclusion(state, evalResult);
      expect(conclusion.kind).toBe('next_action');
      if (conclusion.kind === 'next_action') {
        expect(conclusion.action.visibility).toBe('recommended');
        expect(conclusion.action.invocation).toBeTruthy();
        expect(conclusion.action.description.length).toBeGreaterThan(0);
      }
    });

    it('pending IMPLEMENTATION recommends the product command', () => {
      const state = makeProgressedState('IMPLEMENTATION');
      const evalResult: EvalResult = { kind: 'pending', phase: 'IMPLEMENTATION' };
      const conclusion = buildRailConclusion(state, evalResult);
      expect(conclusion.kind).toBe('next_action');
    });
  });

  describe('HAPPY — user gate → decision_required', () => {
    it('PLAN_REVIEW waiting yields the product decision commands', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const evalResult: EvalResult = {
        kind: 'waiting',
        phase: 'PLAN_REVIEW',
        reason: 'Human review decision required at PLAN_REVIEW.',
      };
      const conclusion = buildRailConclusion(state, evalResult);
      expect(conclusion.kind).toBe('decision_required');
      if (conclusion.kind === 'decision_required') {
        expect(conclusion.question).toBe('Human review decision required at PLAN_REVIEW.');
        const invocations = conclusion.actions.map((a) => a.invocation);
        expect(invocations).toEqual(['/approve', '/request-changes', '/reject']);
        for (const action of conclusion.actions) {
          expect(action.visibility).toBe('available');
          expect(action.description.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('HAPPY — terminal phases', () => {
    it('clean COMPLETE routes to /export as recommended next_action', () => {
      const state = makeProgressedState('COMPLETE');
      const evalResult: EvalResult = { kind: 'terminal' };
      const conclusion = buildRailConclusion(state, evalResult);
      expect(conclusion.kind).toBe('next_action');
      if (conclusion.kind === 'next_action') {
        expect(conclusion.action.invocation).toBe('/export');
      }
    });

    it('aborted COMPLETE routes to /status, never /export (governance integrity)', () => {
      const state = abortedComplete();
      const evalResult: EvalResult = { kind: 'terminal' };
      const conclusion = buildRailConclusion(state, evalResult);
      expect(conclusion.kind).toBe('next_action');
      if (conclusion.kind === 'next_action') {
        expect(conclusion.action.invocation).toBe('/status');
        expect(conclusion.action.invocation).not.toBe('/export');
      }
    });
  });

  describe('CORNER — terminal message (no product command)', () => {
    it('READY with a pending standalone review obligation → terminal reviewer message', () => {
      // resolveNextAction returns RUN_REVIEWER_TASK here, whose product
      // projection has an empty command list but non-empty guidance text →
      // a terminal conclusion carrying that text (never an invented command).
      const obligation = createReviewObligation({
        obligationType: 'review',
        iteration: 1,
        planVersion: 1,
        now: '2026-01-01T00:00:00.000Z',
      });
      const state = makeState('READY', {
        reviewAssurance: { obligations: [obligation], invocations: [] },
      });
      const evalResult: EvalResult = { kind: 'pending', phase: 'READY' };
      const conclusion = buildRailConclusion(state, evalResult);
      expect(conclusion.kind).toBe('terminal');
      if (conclusion.kind === 'terminal') {
        expect(conclusion.message).toContain('flowguard-reviewer');
      }
    });
  });
});
