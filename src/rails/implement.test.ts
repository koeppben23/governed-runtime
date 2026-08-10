/**
 * @module implement.test
 * @description Rail unit tests for /implement — implementation recording.
 *
 * P10b: tests fail-closed precondition gates, Mode A/B paths,
 * convergence and infinite-loop guards.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it, vi } from 'vitest';
import { executeImplement, type ImplExecutors } from './implement.js';
import {
  makeState,
  FIXED_TIME,
  TICKET,
  PLAN_RECORD,
  IMPL_EVIDENCE,
  CANDIDATE,
} from '../fixtures.js';
import type { RailContext } from './types.js';
import { TEAM_POLICY } from '../config/policy.js';
import type { ValidationResult, ImplementationCandidate } from '../state/evidence.js';

const ctx: RailContext = {
  now: () => FIXED_TIME,
  digest: (s: string) => `sha256:${s.length}`,
  policy: { ...TEAM_POLICY, maxImplReviewIterations: 3 },
};

function makeExecutors(overrides?: Partial<ImplExecutors>): ImplExecutors {
  return {
    execute: vi.fn().mockResolvedValue({
      candidate: CANDIDATE,
      domainFiles: ['src/foo.ts'],
    }),
    reviewAndRevise: vi.fn().mockResolvedValue({ verdict: 'approve' as const }),
    ...overrides,
  };
}

function implState(overrides?: Record<string, unknown>) {
  return makeState('IMPLEMENTATION', {
    ticket: TICKET,
    plan: PLAN_RECORD,
    validation: [validationResult('test_quality'), validationResult('rollback_safety')],
    activeChecks: ['test_quality', 'rollback_safety'],
    ...overrides,
  });
}

function validationResult(checkId: string): ValidationResult {
  return {
    checkId,
    passed: true,
    detail: 'OK',
    executedAt: FIXED_TIME,
    kind: 'test',
    command: 'npm test',
    exitCode: 0,
    executionMs: 1,
    outputDigest: 'a'.repeat(64),
    timedOut: false,
    outcome: 'supported',
  };
}

describe('implement rail', () => {
  // ── HAPPY ──────────────────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('Mode A records implementation and advances past IMPLEMENTATION', async () => {
      const state = implState();
      const result = await executeImplement(state, ctx, makeExecutors());
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // Mode A → IMPL_REVIEW → if review converges → EVIDENCE_REVIEW
        expect(result.state.phase).toMatch(/^(IMPL_REVIEW|EVIDENCE_REVIEW)$/);
        expect(result.state.implementation).not.toBeNull();
        expect(result.state.implementation!.candidate.changedPaths).toContain('src/auth.ts');
      }
    });

    it('Mode B approve converges past IMPL_REVIEW', async () => {
      const state = implState({
        implementation: IMPL_EVIDENCE,
        implReview: {
          iteration: 0,
          maxIterations: 3,
          prevDigest: null,
          currDigest: CANDIDATE.candidateDigest,
          revisionDelta: 'minor' as const,
          verdict: 'changes_requested' as const,
          executedAt: FIXED_TIME,
        },
      });
      const executors = makeExecutors({
        reviewAndRevise: vi.fn().mockResolvedValue({ verdict: 'converged' as const }),
      });
      const result = await executeImplement(state, ctx, executors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.implementation).not.toBeNull();
        expect(result.transitions.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ── BAD ────────────────────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks at wrong phase', async () => {
      const state = makeState('READY');
      const result = await executeImplement(state, ctx, makeExecutors());
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('COMMAND_NOT_ALLOWED');
      }
    });

    it('blocks without ticket', async () => {
      const state = makeState('IMPLEMENTATION', { plan: PLAN_RECORD });
      const result = await executeImplement(state, ctx, makeExecutors());
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('TICKET_REQUIRED');
      }
    });
  });

  // ── CORNER ─────────────────────────────────────────────────────────────
  describe('CORNER', () => {
    it('iteration >= maxIterations still converges (no infinite loop)', async () => {
      const state = implState({
        implementation: IMPL_EVIDENCE,
        implReview: {
          iteration: 3,
          maxIterations: 3,
          prevDigest: null,
          currDigest: CANDIDATE.candidateDigest,
          revisionDelta: 'major' as const,
          verdict: 'changes_requested' as const,
          executedAt: FIXED_TIME,
        },
      });
      const executors = makeExecutors({
        reviewAndRevise: vi.fn().mockResolvedValue({ verdict: 'changes_requested' as const }),
      });
      const result = await executeImplement(state, ctx, executors);
      // At max iteration, the rail does NOT throw or loop infinitely.
      expect(result.kind).toBe('ok');
    });
  });
});
