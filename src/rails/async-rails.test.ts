import { describe, it, expect } from 'vitest';
import { executePlan } from '../rails/plan';
import { executeValidate } from '../rails/validate';
import { executeImplement } from '../rails/implement';
import { executeContinue } from '../rails/continue';
import { createTestContext } from '../testing';
import {
  makeState,
  makeProgressedState,
  TICKET,
  PLAN_RECORD,
  PLAN_EVIDENCE,
  SELF_REVIEW_CONVERGED,
  VALIDATION_PASSED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
  IMPL_REVIEW_PENDING_RESULT,
  ARCHITECTURE_DECISION,
} from '../__fixtures__';
import { SOLO_POLICY, TEAM_POLICY } from '../config/policy';

const ctx = createTestContext();

describe('plan rail', () => {
  const planExecutors = {
    generate: async () => '## Generated Plan\n1. Fix bug\n2. Add tests',
    selfReview: async () => ({ verdict: 'approve' as const }),
  };

  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('generates plan and advances to PLAN_REVIEW on convergence', async () => {
      const state = makeState('TICKET', { ticket: TICKET });
      const result = await executePlan(state, {}, ctx, planExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.plan).not.toBeNull();
        expect(result.state.plan!.current.body).toContain('Generated Plan');
        expect(result.state.selfReview).not.toBeNull();
        expect(result.state.selfReview!.verdict).toBe('approve');
        // Auto-advances through PLAN to PLAN_REVIEW
        expect(result.state.phase).toBe('PLAN_REVIEW');
      }
    });

    it('accepts user-provided plan text', async () => {
      const state = makeState('TICKET', { ticket: TICKET });
      const result = await executePlan(state, { text: '## My Plan\nStep 1' }, ctx, planExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.plan!.current.body).toBe('## My Plan\nStep 1');
      }
    });

    it('preserves plan history on re-planning', async () => {
      const state = makeState('PLAN', { ticket: TICKET, plan: PLAN_RECORD });
      const result = await executePlan(state, { text: '## New Plan\nRevised' }, ctx, planExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.plan!.history.length).toBeGreaterThan(0);
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks without ticket', async () => {
      const result = await executePlan(makeState('TICKET'), {}, ctx, planExecutors);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('TICKET_REQUIRED');
    });

    it('blocks on empty plan text', async () => {
      const state = makeState('TICKET', { ticket: TICKET });
      const result = await executePlan(state, { text: '' }, ctx, {
        generate: async () => '',
        selfReview: async () => ({ verdict: 'approve' as const }),
      });
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('EMPTY_PLAN');
    });

    it('blocks in wrong phase', async () => {
      const result = await executePlan(makeState('VALIDATION'), {}, ctx, planExecutors);
      expect(result.kind).toBe('blocked');
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('self-review loop runs multiple iterations when changes requested', async () => {
      let iteration = 0;
      const iteratingExecutors = {
        generate: async () => '## Plan\nStep 1',
        selfReview: async () => {
          iteration++;
          if (iteration < 2) {
            return {
              verdict: 'changes_requested' as const,
              revisedBody: '## Revised\nBetter plan',
            };
          }
          return { verdict: 'approve' as const };
        },
      };
      const state = makeState('TICKET', { ticket: TICKET });
      const result = await executePlan(state, {}, ctx, iteratingExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview!.iteration).toBe(2);
      }
    });

    it('maxIterations from policy limits loop (solo = 1)', async () => {
      let count = 0;
      const neverApprove = {
        generate: async () => '## Plan',
        selfReview: async () => {
          count++;
          return { verdict: 'changes_requested' as const, revisedBody: `## Rev ${count}` };
        },
      };
      const soloCtx = { ...ctx, policy: SOLO_POLICY };
      const state = makeState('TICKET', { ticket: TICKET });
      const result = await executePlan(state, {}, soloCtx, neverApprove);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.selfReview!.iteration).toBe(2);
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('plan is allowed in both TICKET and PLAN phases', async () => {
      const ticketState = makeState('TICKET', { ticket: TICKET });
      const r1 = await executePlan(ticketState, { text: 'Plan' }, ctx, planExecutors);
      expect(r1.kind).toBe('ok');

      const planState = makeState('PLAN', { ticket: TICKET, plan: PLAN_RECORD });
      const r2 = await executePlan(planState, { text: 'New Plan' }, ctx, planExecutors);
      expect(r2.kind).toBe('ok');
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('plan execution with instant executors is fast', async () => {
      const state = makeState('TICKET', { ticket: TICKET });
      const start = performance.now();
      await executePlan(state, { text: 'Plan' }, ctx, planExecutors);
      expect(performance.now() - start).toBeLessThan(100);
    });
  });
});

describe('validate rail', () => {
  const validateExecutors = {
    runCheck: async (checkId: string) => ({
      checkId,
      passed: true,
      detail: `${checkId} passed`,
      executedAt: '2026-01-01T00:00:00.000Z',
    }),
  };

  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('runs all checks and advances to IMPLEMENTATION on ALL_PASSED', async () => {
      const state = makeProgressedState('VALIDATION');
      const result = await executeValidate(state, ctx, validateExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.validation.length).toBe(2);
        expect(result.state.validation.every((v) => v.passed)).toBe(true);
        expect(result.state.phase).toBe('IMPLEMENTATION');
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks in wrong phase', async () => {
      const result = await executeValidate(makeState('TICKET'), ctx, validateExecutors);
      expect(result.kind).toBe('blocked');
    });

    it('blocks with no active checks', async () => {
      const state = makeState('VALIDATION', { activeChecks: [] });
      const result = await executeValidate(state, ctx, validateExecutors);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('NO_ACTIVE_CHECKS');
    });

    it('blocks without plan', async () => {
      const state = makeState('VALIDATION', { plan: null });
      const result = await executeValidate(state, ctx, validateExecutors);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('PLAN_REQUIRED');
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('CHECK_FAILED → back to PLAN when a check fails', async () => {
      const failExecutors = {
        runCheck: async (checkId: string) => ({
          checkId,
          passed: checkId !== 'test_quality',
          detail: checkId === 'test_quality' ? 'failed' : 'passed',
          executedAt: '2026-01-01T00:00:00.000Z',
        }),
      };
      const state = makeProgressedState('VALIDATION');
      const result = await executeValidate(state, ctx, failExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('PLAN');
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('runs checks in activeChecks order', async () => {
      const order: string[] = [];
      const trackingExecutors = {
        runCheck: async (checkId: string) => {
          order.push(checkId);
          return { checkId, passed: true, detail: 'ok', executedAt: '2026-01-01T00:00:00.000Z' };
        },
      };
      const state = makeProgressedState('VALIDATION');
      await executeValidate(state, ctx, trackingExecutors);
      expect(order).toEqual(['test_quality', 'rollback_safety']);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('validate with instant executors is fast', async () => {
      const state = makeProgressedState('VALIDATION');
      const start = performance.now();
      await executeValidate(state, ctx, validateExecutors);
      expect(performance.now() - start).toBeLessThan(100);
    });
  });
});

describe('implement rail', () => {
  const implExecutors = {
    execute: async () => ({
      changedFiles: ['src/auth.ts'],
      domainFiles: ['src/auth.ts'],
    }),
    reviewAndRevise: async () => ({ verdict: 'approve' as const }),
  };

  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('executes impl and advances through IMPL_REVIEW to EVIDENCE_REVIEW', async () => {
      const state = makeProgressedState('IMPLEMENTATION');
      const result = await executeImplement(state, ctx, implExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.implementation).not.toBeNull();
        expect(result.state.implReview).not.toBeNull();
        expect(result.state.phase).toBe('EVIDENCE_REVIEW');
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks in wrong phase', async () => {
      const result = await executeImplement(makeState('TICKET'), ctx, implExecutors);
      expect(result.kind).toBe('blocked');
    });

    it('blocks without ticket', async () => {
      const state = makeState('IMPLEMENTATION');
      const result = await executeImplement(state, ctx, implExecutors);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('TICKET_REQUIRED');
    });

    it('blocks without plan', async () => {
      const state = makeState('IMPLEMENTATION', { ticket: TICKET });
      const result = await executeImplement(state, ctx, implExecutors);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('PLAN_REQUIRED');
    });

    it('blocks without completed validation', async () => {
      const state = makeState('IMPLEMENTATION', { ticket: TICKET, plan: PLAN_RECORD });
      const result = await executeImplement(state, ctx, implExecutors);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('VALIDATION_INCOMPLETE');
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('impl review loop respects maxIterations from policy', async () => {
      let count = 0;
      const neverApprove = {
        execute: async () => ({ changedFiles: ['a.ts'], domainFiles: [] }),
        reviewAndRevise: async () => {
          count++;
          return { verdict: 'changes_requested' as const };
        },
      };
      const soloCtx = { ...ctx, policy: SOLO_POLICY };
      const state = makeProgressedState('IMPLEMENTATION');
      await executeImplement(state, soloCtx, neverApprove);
      expect(count).toBe(1); // SOLO = maxImplReviewIterations: 1
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('records multiple transitions (IMPLEMENTATION→IMPL_REVIEW→EVIDENCE_REVIEW)', async () => {
      const state = makeProgressedState('IMPLEMENTATION');
      const result = await executeImplement(state, ctx, implExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.transitions.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('implement with instant executors is fast', async () => {
      const state = makeProgressedState('IMPLEMENTATION');
      const start = performance.now();
      await executeImplement(state, ctx, implExecutors);
      expect(performance.now() - start).toBeLessThan(100);
    });
  });
});

describe('continue rail', () => {
  const continueExecutors = {
    runCheck: async (checkId: string) => ({
      checkId,
      passed: true,
      detail: 'passed',
      executedAt: '2026-01-01T00:00:00.000Z',
    }),
    selfReview: async () => ({ verdict: 'approve' as const }),
    implReview: async () => ({ verdict: 'approve' as const }),
    architectureReview: async () => ({ verdict: 'approve' as const }),
  };

  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('at TICKET without evidence → pending', async () => {
      const result = await executeContinue(makeState('TICKET'), ctx, continueExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.evalResult.kind).toBe('pending');
      }
    });

    it('at VALIDATION → runs checks and advances', async () => {
      const state = makeProgressedState('VALIDATION');
      const result = await executeContinue(state, ctx, continueExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.validation.length).toBe(2);
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks at COMPLETE (terminal blocks mutating commands)', async () => {
      // COMPLETE blocks ALL mutating commands — /continue is mutating, so it's blocked.
      // The admissibility check fires before the TERMINAL quick-exit.
      const state = makeProgressedState('COMPLETE');
      const result = await executeContinue(state, ctx, continueExecutors);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('COMMAND_NOT_ALLOWED');
      }
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('at PLAN_REVIEW → waiting (use /review-decision)', async () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const result = await executeContinue(state, ctx, continueExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.evalResult.kind).toBe('waiting');
      }
    });

    it('at EVIDENCE_REVIEW → waiting', async () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const result = await executeContinue(state, ctx, continueExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.evalResult.kind).toBe('waiting');
      }
    });

    it('at ARCH_REVIEW → waiting', async () => {
      const state = makeProgressedState('ARCH_REVIEW');
      const result = await executeContinue(state, ctx, continueExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.evalResult.kind).toBe('waiting');
      }
    });

    it('at ARCH_COMPLETE → blocked (terminal)', async () => {
      const state = makeProgressedState('ARCH_COMPLETE');
      const result = await executeContinue(state, ctx, continueExecutors);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('COMMAND_NOT_ALLOWED');
      }
    });

    it('at REVIEW_COMPLETE → blocked (terminal)', async () => {
      const state = makeProgressedState('REVIEW_COMPLETE');
      const result = await executeContinue(state, ctx, continueExecutors);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('COMMAND_NOT_ALLOWED');
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('at PLAN with converged self-review → advances to PLAN_REVIEW', async () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
      });
      const result = await executeContinue(state, ctx, continueExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('PLAN_REVIEW');
      }
    });

    it('at ARCHITECTURE runs ADR self-review and advances to ARCH_REVIEW on convergence', async () => {
      const state = makeState('ARCHITECTURE', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: {
          iteration: 0,
          maxIterations: 3,
          prevDigest: null,
          currDigest: ARCHITECTURE_DECISION.digest,
          revisionDelta: 'major',
          verdict: 'changes_requested',
        },
      });
      const result = await executeContinue(state, ctx, continueExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // approve + no change → converged → ARCH_REVIEW
        expect(result.state.selfReview!.verdict).toBe('approve');
        expect(result.state.phase).toBe('ARCH_REVIEW');
      }
    });

    it('at ARCHITECTURE with changes_requested updates ADR text', async () => {
      const revisedText =
        '## Context\nRevised.\n\n## Decision\nChanged.\n\n## Consequences\nUpdated.';
      const reviseExecutors = {
        ...continueExecutors,
        architectureReview: async () => ({
          verdict: 'changes_requested' as const,
          revisedText,
        }),
      };
      const state = makeState('ARCHITECTURE', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: {
          iteration: 0,
          maxIterations: 3,
          prevDigest: null,
          currDigest: ARCHITECTURE_DECISION.digest,
          revisionDelta: 'major',
          verdict: 'changes_requested',
        },
      });
      const result = await executeContinue(state, ctx, reviseExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.architecture!.adrText).toBe(revisedText);
        expect(result.state.selfReview!.iteration).toBe(1);
      }
    });

    it('at ARCHITECTURE without architecture evidence → no-op', async () => {
      const state = makeState('ARCHITECTURE');
      const result = await executeContinue(state, ctx, continueExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // No architecture → no self-review work, just evaluate → pending
        expect(result.evalResult.kind).toBe('pending');
      }
    });

    it('at REVIEW → auto-advances to REVIEW_COMPLETE', async () => {
      const state = makeState('REVIEW');
      const result = await executeContinue(state, ctx, continueExecutors);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        // reviewDone guard fires immediately when phase === "REVIEW"
        expect(result.state.phase).toBe('REVIEW_COMPLETE');
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('continue at TICKET is fast', async () => {
      const start = performance.now();
      await executeContinue(makeState('TICKET'), ctx, continueExecutors);
      expect(performance.now() - start).toBeLessThan(100);
    });
  });
});
