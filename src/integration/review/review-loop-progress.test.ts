/**
 * @module integration/review/review-loop-progress.test
 * @description Tests for the read-only review loop progress projection.
 */

import { describe, it, expect } from 'vitest';
import { getReviewLoopProgress } from './review-loop-progress.js';
import { makeState } from '../../__fixtures__.js';
import type { SessionState } from '../../state/schema.js';

function reviewState(phase: string, overrides: Partial<SessionState> = {}): SessionState {
  return makeState(phase as SessionState['phase'], overrides);
}

function makeReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iteration: 1,
    maxIterations: 3,
    prevDigest: 'prev',
    currDigest: 'curr',
    revisionDelta: 'major',
    verdict: 'approve',
    ...overrides,
  };
}

describe('getReviewLoopProgress', () => {
  describe('HAPPY', () => {
    it('returns progress for PLAN_REVIEW with selfReview', () => {
      const state = reviewState('PLAN_REVIEW', {
        selfReview: {
          iteration: 2,
          maxIterations: 3,
          prevDigest: 'prev',
          currDigest: 'curr',
          revisionDelta: 'major',
          verdict: 'changes_requested',
        },
        reviewAssurance: {
          obligations: [],
          invocations: [
            {
              invocationId: 'inv-1',
              obligationId: 'obl-1',
              obligationType: 'plan',
              parentSessionId: 'parent',
              childSessionId: 'child',
              agentType: 'flowguard-reviewer',
              invocationMode: 'sdk_session_prompt',
              hostVisible: false,
              promptHash: 'h1',
              findingsHash: 'h2',
              mandateDigest: 'md',
              criteriaVersion: 'cv',
              invokedAt: '2026-01-01T00:00:00.000Z',
              fulfilledAt: null,
              consumedByObligationId: null,
              reviewOutputMode: 'structured_output',
              structuredOutputUsed: true,
              reviewAssuranceLevel: 'structured_high',
              capturedRawFindings: {
                blockingIssues: [
                  { severity: 'high', category: 'design', message: 'Missing error handling' },
                  { severity: 'medium', category: 'performance', message: 'No rollback plan' },
                  { severity: 'low', category: 'testing', message: 'No integration tests' },
                  { severity: 'low', category: 'docs', message: 'Changelog missing' },
                ],
              },
            },
          ],
        },
      });
      const p = getReviewLoopProgress(state)!;
      expect(p.iteration).toBe(2);
      expect(p.maxIterations).toBe(3);
      expect(p.previousVerdict).toBe('changes_requested');
      expect(p.converged).toBe(false);
      expect(p.outstandingIssues).toEqual([
        'Missing error handling',
        'No rollback plan',
        'No integration tests',
      ]);
    });

    it('returns progress for ARCH_REVIEW with selfReview', () => {
      const state = reviewState('ARCH_REVIEW', {
        selfReview: {
          iteration: 1,
          maxIterations: 5,
          prevDigest: 'p',
          currDigest: 'c',
          revisionDelta: 'none',
          verdict: 'approve',
        },
      });
      const p = getReviewLoopProgress(state)!;
      expect(p.iteration).toBe(1);
      expect(p.maxIterations).toBe(5);
      expect(p.previousVerdict).toBe('approve');
      expect(p.converged).toBe(true);
      expect(p.outstandingIssues).toBeUndefined();
    });

    it('returns progress for IMPL_REVIEW with implReview', () => {
      const state = reviewState('IMPL_REVIEW', {
        implReview: {
          iteration: 0,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'd',
          revisionDelta: 'minor',
          verdict: 'changes_requested',
          executedAt: '2026-01-01T00:00:00.000Z',
        },
        implReviewFindings: [
          {
            iteration: 0,
            planVersion: 1,
            reviewMode: 'subagent',
            overallVerdict: 'changes_requested',
            blockingIssues: [
              { severity: 'high', category: 'security', message: 'Use prepared statements' },
            ],
            majorRisks: [],
            missingVerification: [],
            scopeCreep: [],
            unknowns: [],
            reviewedBy: { sessionId: 'child' },
            reviewedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
      const p = getReviewLoopProgress(state)!;
      expect(p.iteration).toBe(0);
      expect(p.maxIterations).toBe(3);
      expect(p.previousVerdict).toBe('changes_requested');
      expect(p.converged).toBe(false);
      expect(p.outstandingIssues).toEqual(['Use prepared statements']);
    });

    it('outstandingIssues capped at 3 entries', () => {
      const issues = [
        { severity: 'high' as const, category: 'a' as const, message: 'A' },
        { severity: 'high' as const, category: 'b' as const, message: 'B' },
        { severity: 'high' as const, category: 'c' as const, message: 'C' },
        { severity: 'high' as const, category: 'd' as const, message: 'D' },
      ];
      const state = reviewState('IMPL_REVIEW', {
        implReview: {
          iteration: 1,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'd',
          revisionDelta: 'major',
          verdict: 'changes_requested',
          executedAt: '2026-01-01T00:00:00.000Z',
        },
        implReviewFindings: [
          {
            iteration: 1,
            planVersion: 1,
            reviewMode: 'subagent',
            overallVerdict: 'changes_requested',
            blockingIssues: issues,
            majorRisks: [],
            missingVerification: [],
            scopeCreep: [],
            unknowns: [],
            reviewedBy: { sessionId: 'c' },
            reviewedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
      expect(getReviewLoopProgress(state)!.outstandingIssues).toHaveLength(3);
    });
  });

  describe('BAD', () => {
    it('returns null for PLAN with selfReview (not a review phase)', () => {
      const state = reviewState('PLAN', {
        selfReview: {
          iteration: 1,
          maxIterations: 3,
          prevDigest: 'p',
          currDigest: 'c',
          revisionDelta: 'none',
          verdict: 'approve',
        },
      });
      expect(getReviewLoopProgress(state)).toBeNull();
    });

    it('returns null for ARCHITECTURE with selfReview (not a review phase)', () => {
      const state = reviewState('ARCHITECTURE', {
        selfReview: {
          iteration: 1,
          maxIterations: 3,
          prevDigest: 'p',
          currDigest: 'c',
          revisionDelta: 'none',
          verdict: 'approve',
        },
      });
      expect(getReviewLoopProgress(state)).toBeNull();
    });

    it('returns null for PLAN_REVIEW with null selfReview', () => {
      expect(getReviewLoopProgress(reviewState('PLAN_REVIEW', { selfReview: null }))).toBeNull();
    });

    it('returns null for non-review phases', () => {
      for (const phase of ['TICKET', 'VALIDATION', 'IMPLEMENTATION', 'COMPLETE', 'READY']) {
        expect(getReviewLoopProgress(reviewState(phase))).toBeNull();
      }
    });

    it('returns null when review slot has no verdict', () => {
      const state = reviewState('PLAN_REVIEW', {
        selfReview: makeReview({ verdict: '' }),
      });
      expect(getReviewLoopProgress(state)).toBeNull();
    });

    it('returns null when review slot has an invalid verdict', () => {
      const state = reviewState('PLAN_REVIEW', {
        selfReview: makeReview({ verdict: 'invalid' }),
      });
      expect(getReviewLoopProgress(state)).toBeNull();
    });

    it('does not throw when capturedRawFindings.blockingIssues is malformed', () => {
      const state = reviewState('PLAN_REVIEW', {
        selfReview: {
          iteration: 1,
          maxIterations: 3,
          prevDigest: 'p',
          currDigest: 'c',
          revisionDelta: 'major',
          verdict: 'changes_requested',
        },
        reviewAssurance: {
          obligations: [],
          invocations: [
            {
              invocationId: 'inv-1',
              obligationId: 'obl-1',
              obligationType: 'plan',
              parentSessionId: 'parent',
              childSessionId: 'child',
              agentType: 'flowguard-reviewer',
              invocationMode: 'sdk_session_prompt',
              hostVisible: false,
              promptHash: 'h1',
              findingsHash: 'h2',
              mandateDigest: 'md',
              criteriaVersion: 'cv',
              invokedAt: '2026-01-01T00:00:00.000Z',
              fulfilledAt: null,
              consumedByObligationId: null,
              reviewOutputMode: 'structured_output',
              structuredOutputUsed: true,
              reviewAssuranceLevel: 'structured_high',
              capturedRawFindings: {
                blockingIssues: { message: 'bad shape' },
              },
            },
          ],
        },
      });
      const p = getReviewLoopProgress(state)!;
      expect(p.iteration).toBe(1);
      expect(p.outstandingIssues).toBeUndefined();
    });

    it('does not surface non-string messages from capturedRawFindings', () => {
      const state = reviewState('PLAN_REVIEW', {
        selfReview: {
          iteration: 1,
          maxIterations: 3,
          prevDigest: 'p',
          currDigest: 'c',
          revisionDelta: 'major',
          verdict: 'changes_requested',
        },
        reviewAssurance: {
          obligations: [],
          invocations: [
            {
              invocationId: 'inv-1',
              obligationId: 'obl-1',
              obligationType: 'plan',
              parentSessionId: 'parent',
              childSessionId: 'child',
              agentType: 'flowguard-reviewer',
              invocationMode: 'sdk_session_prompt',
              hostVisible: false,
              promptHash: 'h1',
              findingsHash: 'h2',
              mandateDigest: 'md',
              criteriaVersion: 'cv',
              invokedAt: '2026-01-01T00:00:00.000Z',
              fulfilledAt: null,
              consumedByObligationId: null,
              reviewOutputMode: 'structured_output',
              structuredOutputUsed: true,
              reviewAssuranceLevel: 'structured_high',
              capturedRawFindings: {
                blockingIssues: [{ message: { raw: 'bad' } }, { message: 123 }],
              },
            },
          ],
        },
      });
      const p = getReviewLoopProgress(state)!;
      expect(p.outstandingIssues).toBeUndefined();
    });

    it('outstandingIssues absent when verdict is approve', () => {
      const state = reviewState('PLAN_REVIEW', {
        selfReview: {
          iteration: 1,
          maxIterations: 3,
          prevDigest: 'p',
          currDigest: 'c',
          revisionDelta: 'none',
          verdict: 'approve',
        },
      });
      expect(getReviewLoopProgress(state)!.outstandingIssues).toBeUndefined();
    });

    it('outstandingIssues absent when verdict is unable_to_review', () => {
      const state = reviewState('PLAN_REVIEW', {
        selfReview: {
          iteration: 1,
          maxIterations: 3,
          prevDigest: 'p',
          currDigest: 'c',
          revisionDelta: 'none',
          verdict: 'unable_to_review',
        },
      });
      const p = getReviewLoopProgress(state)!;
      expect(p.converged).toBe(false);
      expect(p.outstandingIssues).toBeUndefined();
    });
  });

  describe('SURFACE', () => {
    it('formatRailResult includes reviewLoop in PLAN_REVIEW', async () => {
      const { formatRailResult } = await import('../tools/helpers.js');
      const { makeState } = await import('../../__fixtures__.js');

      const state = makeState('PLAN_REVIEW', {
        selfReview: {
          iteration: 2,
          maxIterations: 3,
          prevDigest: 'p',
          currDigest: 'c',
          revisionDelta: 'major' as const,
          verdict: 'changes_requested' as const,
        },
      });

      const result = formatRailResult({
        kind: 'ok',
        state,
        evalResult: { kind: 'waiting' as const, phase: 'PLAN_REVIEW' as const },
        transitions: [],
      });

      const output = typeof result === 'string' ? result : (result as { output: string }).output;
      const parsed = JSON.parse(output) as Record<string, unknown>;
      const rl = parsed.reviewLoop as Record<string, unknown> | undefined;
      expect(rl).toBeDefined();
      expect(rl!.iteration).toBe(2);
      expect(rl!.maxIterations).toBe(3);
      expect(rl!.previousVerdict).toBe('changes_requested');
      expect(rl!.converged).toBe(false);
    });

    it('formatRailResult omits reviewLoop in non-review phase', async () => {
      const { formatRailResult } = await import('../tools/helpers.js');
      const { makeState } = await import('../../__fixtures__.js');

      const state = makeState('TICKET', {});

      const result = formatRailResult({
        kind: 'ok',
        state,
        evalResult: { kind: 'waiting' as const, phase: 'TICKET' as const },
        transitions: [],
      });

      const output = typeof result === 'string' ? result : (result as { output: string }).output;
      const parsed = JSON.parse(output) as Record<string, unknown>;
      expect(parsed.reviewLoop).toBeUndefined();
    });

    it('buildStatusProjection includes reviewLoop in IMPL_REVIEW', async () => {
      const { buildStatusProjection } = await import('../status.js');
      const { makeState } = await import('../../__fixtures__.js');

      const state = makeState('IMPL_REVIEW', {
        implReview: {
          iteration: 0,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'd',
          revisionDelta: 'minor' as const,
          verdict: 'changes_requested' as const,
          executedAt: '2026-01-01T00:00:00.000Z',
        },
      });

      const projection = buildStatusProjection(state, {
        mode: 'solo',
        requireHumanGates: false,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitToolCalls: false, emitTransitions: false, enableChainHash: false },
        actorClassification: {},
      } as Parameters<typeof buildStatusProjection>[1]);

      expect(projection.reviewLoop).toBeDefined();
      expect(projection.reviewLoop!.iteration).toBe(0);
      expect(projection.reviewLoop!.maxIterations).toBe(3);
    });

    it('buildStatusProjection reviewLoop is null in non-review phase', async () => {
      const { buildStatusProjection } = await import('../status.js');
      const { makeState } = await import('../../__fixtures__.js');

      const state = makeState('TICKET', {});

      const projection = buildStatusProjection(state, {
        mode: 'solo',
        requireHumanGates: false,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitToolCalls: false, emitTransitions: false, enableChainHash: false },
        actorClassification: {},
      } as Parameters<typeof buildStatusProjection>[1]);

      expect(projection.reviewLoop).toBeNull();
    });
  });
});
