/**
 * @module implement.test
 * @description Rail unit tests for /implement — implementation recording.
 *
 * P10b: tests fail-closed precondition gates, fresh post-implementation
 * validation, and convergence/infinite-loop guards.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, expect, it, vi } from 'vitest';
import { executeImplement, type ImplExecutors } from './implement.js';
import { makeState, FIXED_TIME, TICKET, PLAN_RECORD, IMPL_EVIDENCE } from '../fixtures.js';
import type { RailContext } from './types.js';
import { TEAM_POLICY } from '../config/policy.js';
import type { ValidationResult } from '../state/evidence.js';

const ctx: RailContext = {
  now: () => FIXED_TIME,
  digest: (s: string) => `sha256:${s.length}`,
  policy: { ...TEAM_POLICY, reviewBudget: { ...TEAM_POLICY.reviewBudget, implementation: 3 } },
};

function makeExecutors(overrides?: Partial<ImplExecutors>): ImplExecutors {
  return {
    execute: vi.fn().mockResolvedValue({
      changedFiles: ['src/foo.ts', 'src/foo.test.ts'],
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
    it('records implementation and stops in IMPL_VALIDATION until every active check is rerun', async () => {
      const state = implState();
      const executors = makeExecutors();
      const result = await executeImplement(state, ctx, executors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('IMPL_VALIDATION');
        expect(result.state.implementation).not.toBeNull();
        expect(result.state.implementation!.changedFiles).toContain('src/foo.ts');
        expect(result.state.implValidation).toEqual([]);
        expect(result.state.validation.map((item) => item.checkId)).toEqual([
          'test_quality',
          'rollback_safety',
        ]);
      }
      expect(executors.reviewAndRevise).not.toHaveBeenCalled();
    });

    it('does not let passing baseline build/test evidence satisfy the new implementation subject', async () => {
      const baselineBuild = validationResult('build');
      const baselineTest = validationResult('test');
      const state = implState({
        activeChecks: ['build', 'test'],
        validation: [baselineBuild, baselineTest],
        implValidation: [baselineBuild, baselineTest],
      });

      const result = await executeImplement(state, ctx, makeExecutors());

      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('IMPL_VALIDATION');
        expect(result.state.implValidation).toEqual([]);
        expect(result.state.validation).toEqual([baselineBuild, baselineTest]);
        expect(result.transitions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ from: 'IMPLEMENTATION', to: 'IMPL_VALIDATION' }),
          ]),
        );
      }
    });

    it('zero-check policy may still use the bundled review seam after implementation', async () => {
      const state = implState({ activeChecks: [], validation: [], implValidation: [] });
      const executors = makeExecutors({
        reviewAndRevise: vi.fn().mockResolvedValue({ verdict: 'converged' as const }),
      });

      const result = await executeImplement(state, ctx, executors);

      expect(result.kind).toBe('ok');
      expect(executors.reviewAndRevise).toHaveBeenCalled();
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
    it('existing review iteration cannot bypass fresh post-implementation validation', async () => {
      const state = implState({
        implementation: IMPL_EVIDENCE,
        implReview: {
          iteration: 3,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'dx',
          revisionDelta: 'major' as const,
          verdict: 'changes_requested' as const,
        },
      });
      const executors = makeExecutors({
        reviewAndRevise: vi.fn().mockResolvedValue({ verdict: 'changes_requested' as const }),
      });
      const result = await executeImplement(state, ctx, executors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('IMPL_VALIDATION');
        expect(result.state.implValidation).toEqual([]);
      }
      expect(executors.reviewAndRevise).not.toHaveBeenCalled();
    });
  });
});
