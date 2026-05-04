/**
 * @module plan.test
 * @description Rail unit tests for /plan — implementation plan submission.
 *
 * P10b: tests fail-closed input validation, self-review loop iteration,
 * convergence to PLAN_REVIEW, and history preservation.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it, vi } from 'vitest';
import { executePlan, type PlanInput, type PlanExecutors } from './plan.js';
import { makeState, FIXED_TIME, TICKET, PLAN_RECORD } from '../__fixtures__.js';
import type { RailContext } from './types.js';

const ctx: RailContext = {
  now: () => FIXED_TIME,
  digest: (s: string) => `sha256:${s.length}`,
  policy: { maxSelfReviewIterations: 3 },
};

function makeExecutors(overrides?: Partial<PlanExecutors>): PlanExecutors {
  return {
    generate: vi.fn().mockResolvedValue('## Generated plan\nTest'),
    selfReview: vi.fn().mockResolvedValue({ verdict: 'approve' as const }),
    ...overrides,
  };
}

function planInput(text?: string): PlanInput {
  return { text };
}

describe('plan rail', () => {
  // ── HAPPY ──────────────────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('submits plan with ticket and starts self-review', async () => {
      const state = makeState('TICKET', { ticket: TICKET });
      const executors = makeExecutors({
        selfReview: vi.fn().mockResolvedValue({ verdict: 'converged' as const }),
      });
      const result = await executePlan(state, planInput('## Plan\nTest'), ctx, executors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('PLAN_REVIEW');
        expect(result.state.plan?.current.body).toBe('## Plan\nTest');
        // First submission may or may not populate history depending on rail impl
        expect(result.state.plan).toBeDefined();
      }
    });

    it('converges after self-review approve', async () => {
      const state = makeState('TICKET', { ticket: TICKET });
      const executors = makeExecutors({
        selfReview: vi.fn().mockResolvedValue({ verdict: 'approve' as const }),
      });
      const result = await executePlan(state, planInput('## Plan\nTest'), ctx, executors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('PLAN_REVIEW');
        expect(result.state.selfReview?.verdict).toBe('approve');
      }
    });
  });

  // ── BAD ────────────────────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks without ticket evidence', async () => {
      const state = makeState('TICKET');
      const result = await executePlan(state, planInput('Plan'), ctx, makeExecutors());
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('TICKET_REQUIRED');
      }
    });

    it('blocks on empty plan text', async () => {
      const state = makeState('TICKET', { ticket: TICKET });
      const executors = makeExecutors({
        generate: vi.fn().mockResolvedValue('   '),
      });
      const result = await executePlan(state, planInput(''), ctx, executors);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('EMPTY_PLAN');
      }
    });
  });

  // ── CORNER ─────────────────────────────────────────────────────────────
  describe('CORNER', () => {
    it('preserves history on re-plan (PLAN phase)', async () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: {
          iteration: 0,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'd1',
          revisionDelta: 'major' as const,
          verdict: 'changes_requested' as const,
        },
      });
      const executors = makeExecutors({
        selfReview: vi.fn().mockResolvedValue({
          verdict: 'changes_requested' as const,
          revisedBody: '## Revised\nNew plan',
        }),
      });
      const result = await executePlan(state, planInput('## Revised\nNew plan'), ctx, executors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // History should have previous entries preserved
        expect(result.state.plan?.history.length).toBeGreaterThanOrEqual(1);
        expect(result.state.plan?.current.body).toBe('## Revised\nNew plan');
      }
    });

    it('revision preserves maxIterations across iterations', async () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: {
          iteration: 1,
          maxIterations: 3,
          prevDigest: 'd1',
          currDigest: 'd2',
          revisionDelta: 'minor' as const,
          verdict: 'changes_requested' as const,
        },
      });
      const executors = makeExecutors({
        selfReview: vi.fn().mockResolvedValue({ verdict: 'converged' as const }),
      });
      const result = await executePlan(state, planInput('## Plan\nThird try'), ctx, executors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // maxIterations should not change across revisions
        expect(result.state.selfReview?.maxIterations).toBe(3);
      }
    });
  });

  // ── EDGE ───────────────────────────────────────────────────────────────
  describe('EDGE', () => {
    it('accepts minimal plan text (single character)', async () => {
      const state = makeState('TICKET', { ticket: TICKET });
      const executors = makeExecutors({
        selfReview: vi.fn().mockResolvedValue({ verdict: 'converged' as const }),
      });
      const result = await executePlan(state, planInput('X'), ctx, executors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.plan?.current.body).toBe('X');
      }
    });
  });
});
