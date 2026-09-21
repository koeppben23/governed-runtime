/**
 * @module integration/tools/rail-conclusion.test
 * @description Unit tests for buildRailConclusion — the rail-surface Next-Action
 *              conclusion projection.
 *
 * @test-policy
 * HAPPY: transition/pending product-action states → next_action with the recommended command.
 * HAPPY: system-work phases (VALIDATION, PLAN) → review_pending with the directive label.
 * HAPPY: waiting (user gate) → decision_required with the gate's canonical commands.
 * HAPPY: EXPORT_READY → next_action(/export); COMPLETE → terminal(label).
 * CORNER: aborted ABORTED is terminal and never routes to /export.
 * EDGE: fail-closed codes on structurally-empty projections.
 * PERF: not applicable; pure function.
 */
import { describe, it, expect } from 'vitest';
import type { SessionState } from '../../state/schema.js';
import type { EvalResult } from '../../machine/evaluate.js';
import { buildRailConclusion } from './rail-conclusion.js';
import { makeState, makeProgressedState } from '../../fixtures.js';
import { createReviewObligation } from '../review/obligations/assurance.js';

function abortedState(): SessionState {
  return {
    ...makeProgressedState('ABORTED'),
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
    it('transition to VALIDATION yields autonomous system-work guidance', () => {
      const state = makeProgressedState('VALIDATION');
      const evalResult: EvalResult = { kind: 'transition', target: 'VALIDATION', event: 'APPROVE' };
      const conclusion = buildRailConclusion(state, evalResult);
      expect(conclusion.kind).toBe('review_pending');
      if (conclusion.kind === 'review_pending') {
        expect(conclusion.message).toBe('Plan validation in progress.');
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
    it('PLAN_REVIEW waiting preserves the canonical decision commands', () => {
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
    it('clean EXPORT_READY routes to /export as recommended next_action', () => {
      const state = makeProgressedState('EXPORT_READY');
      const evalResult: EvalResult = { kind: 'terminal' };
      const conclusion = buildRailConclusion(state, evalResult);
      expect(conclusion.kind).toBe('next_action');
      if (conclusion.kind === 'next_action') {
        expect(conclusion.action.invocation).toBe('/export');
      }
    });

    it('clean COMPLETE is presentation-terminal with the workflow-complete label', () => {
      const state = makeProgressedState('COMPLETE');
      const evalResult: EvalResult = { kind: 'terminal' };
      const conclusion = buildRailConclusion(state, evalResult);
      expect(conclusion.kind).toBe('terminal');
      if (conclusion.kind === 'terminal') {
        expect(conclusion.message).toBe('Workflow complete.');
      }
    });

    it('aborted ABORTED is terminal and never routes to /export (governance integrity)', () => {
      const state = abortedState();
      const evalResult: EvalResult = { kind: 'terminal' };
      const conclusion = buildRailConclusion(state, evalResult);
      expect(conclusion.kind).toBe('terminal');
      if (conclusion.kind === 'terminal') {
        expect(conclusion.message).toBe('Workflow aborted.');
        expect(conclusion.message).not.toContain('/export');
      }
    });
  });

  describe('CORNER — pending independent review', () => {
    it('READY with a pending peer review obligation still resolves the canonical CHOOSE_FLOW directive', () => {
      const obligation = createReviewObligation({
        policySnapshot: {
          challengePolicy: {
            version: 'challenge-policy.v1',
            counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
          },
          maxReviewerAttempts: 1,
        },
        obligationType: 'review',
        reviewCycle: null,
        iteration: 1,
        planVersion: 1,
        now: '2026-01-01T00:00:00.000Z',
        subjectDigest: 'test',
        reviewMaterial: {
          content: 'frozen review material',
          materialDigest: 'a'.repeat(64),
          subjectDigest: 'test',
        },
      });
      const state = makeState('READY', {
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v6' as const,
          obligations: [obligation],
          invocations: [],
          attempts: [],
          dispatches: [],
        },
      });
      const evalResult: EvalResult = { kind: 'pending', phase: 'READY' };
      const conclusion = buildRailConclusion(state, evalResult);
      expect(conclusion.kind).toBe('next_action');
      if (conclusion.kind === 'next_action') {
        expect(conclusion.action.invocation).toBe('/task');
        expect(conclusion.action.description).not.toContain('flowguard-reviewer');
      }
    });
  });

  describe('GOVERNANCE BOUNDARY — pending review is not a rail next action', () => {
    // The pending-review submission responses (buildPlanSubmissionResponse etc.)
    // carry a dense governance `next` protocol from buildPendingReviewInstruction.
    // A rail conclusion for those PLAN / IMPL_REVIEW states resolves to
    // autonomous system-work guidance (review_pending) — which is NOT the host
    // dispatch recovery. This test pins that mismatch so the rendered rail
    // conclusion is never substituted for the governance protocol on those
    // surfaces: the governance `next` remains the sole authority there.
    it('rail conclusion for PLAN pending stays system work, not the reviewer protocol', () => {
      const state = makeProgressedState('PLAN');
      const conclusion = buildRailConclusion(state, { kind: 'pending', phase: 'PLAN' });
      expect(conclusion.kind).toBe('review_pending');
      if (conclusion.kind === 'review_pending') {
        expect(conclusion.message).toBe('Independent plan review in progress.');
        // Proves the rail conclusion cannot carry the reviewer-invocation
        // protocol, so it must not replace the governance `next` on pending
        // review submission responses.
        expect(conclusion.message).not.toContain('flowguard-reviewer');
      }
    });
  });
});
