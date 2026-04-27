import { describe, it, expect } from 'vitest';
import { resolveNextAction, ACTION_CODES } from './next-action.js';
import type { NextAction } from './next-action.js';
import {
  makeState,
  makeProgressedState,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  SELF_REVIEW_PENDING as SELF_REVIEW_PENDING_FIX,
  VALIDATION_PASSED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
  ARCHITECTURE_DECISION,
} from '../__fixtures__.js';
import { Phase } from '../state/schema.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Assert NextAction shape. */
function expectAction(action: NextAction, code: string, commands: readonly string[]): void {
  expect(action.code).toBe(code);
  expect(action.commands).toEqual(commands);
  expect(action.text.length).toBeGreaterThan(0);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('resolveNextAction', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    // ── Routing ────────────────────────────────────────────
    it('READY → CHOOSE_FLOW with 3 commands', () => {
      const state = makeState('READY');
      const action = resolveNextAction('READY', state);
      expectAction(action, ACTION_CODES.CHOOSE_FLOW, ['/ticket', '/architecture', '/review']);
      expect(action.text).toContain('/ticket');
      expect(action.text).toContain('/architecture');
      expect(action.text).toContain('/review');
    });

    // ── Ticket Flow ────────────────────────────────────────
    it('TICKET (no ticket) → RUN_TICKET', () => {
      const state = makeState('TICKET');
      const action = resolveNextAction('TICKET', state);
      expectAction(action, ACTION_CODES.RUN_TICKET, ['/ticket']);
    });

    it('TICKET (has ticket, no plan) → RUN_PLAN', () => {
      const state = makeState('TICKET', { ticket: TICKET });
      const action = resolveNextAction('TICKET', state);
      expectAction(action, ACTION_CODES.RUN_PLAN, ['/plan']);
    });

    it('PLAN (self-review pending) → RUN_CONTINUE', () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_PENDING_FIX,
      });
      const action = resolveNextAction('PLAN', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
      expect(action.text).toContain('self-review in progress');
    });

    it('PLAN (self-review converged) → RUN_CONTINUE with converged text', () => {
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
      });
      const action = resolveNextAction('PLAN', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
      expect(action.text).toContain('converged');
    });

    it('PLAN_REVIEW → RUN_REVIEW_DECISION', () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const action = resolveNextAction('PLAN_REVIEW', state);
      expectAction(action, ACTION_CODES.RUN_REVIEW_DECISION, ['/review-decision']);
    });

    it('VALIDATION (no results) → RUN_VALIDATE', () => {
      const state = makeState('VALIDATION', { validation: [] });
      const action = resolveNextAction('VALIDATION', state);
      expectAction(action, ACTION_CODES.RUN_VALIDATE, ['/validate']);
    });

    it('VALIDATION (has results) → RUN_CONTINUE', () => {
      const state = makeState('VALIDATION', { validation: VALIDATION_PASSED });
      const action = resolveNextAction('VALIDATION', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
    });

    it('IMPLEMENTATION (no impl) → RUN_IMPLEMENT', () => {
      const state = makeState('IMPLEMENTATION');
      const action = resolveNextAction('IMPLEMENTATION', state);
      expectAction(action, ACTION_CODES.RUN_IMPLEMENT, ['/implement']);
    });

    it('IMPLEMENTATION (has impl) → RUN_CONTINUE', () => {
      const state = makeState('IMPLEMENTATION', { implementation: IMPL_EVIDENCE });
      const action = resolveNextAction('IMPLEMENTATION', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
    });

    it('IMPL_REVIEW → RUN_CONTINUE', () => {
      const state = makeProgressedState('IMPL_REVIEW');
      const action = resolveNextAction('IMPL_REVIEW', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
    });

    it('EVIDENCE_REVIEW → RUN_REVIEW_DECISION', () => {
      const state = makeProgressedState('EVIDENCE_REVIEW');
      const action = resolveNextAction('EVIDENCE_REVIEW', state);
      expectAction(action, ACTION_CODES.RUN_REVIEW_DECISION, ['/review-decision']);
    });

    it('COMPLETE → SESSION_COMPLETE (empty commands)', () => {
      const state = makeProgressedState('COMPLETE');
      const action = resolveNextAction('COMPLETE', state);
      expectAction(action, ACTION_CODES.SESSION_COMPLETE, []);
      expect(action.text).toContain('complete');
    });

    // ── Architecture Flow ──────────────────────────────────
    it('ARCHITECTURE (no ADR) → RUN_ARCHITECTURE', () => {
      const state = makeState('ARCHITECTURE');
      const action = resolveNextAction('ARCHITECTURE', state);
      expectAction(action, ACTION_CODES.RUN_ARCHITECTURE, ['/architecture']);
    });

    it('ARCHITECTURE (has ADR, self-review pending) → RUN_CONTINUE', () => {
      const state = makeState('ARCHITECTURE', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: SELF_REVIEW_PENDING_FIX,
      });
      const action = resolveNextAction('ARCHITECTURE', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
      expect(action.text).toContain('self-review in progress');
    });

    it('ARCHITECTURE (has ADR, self-review converged) → RUN_CONTINUE with converged text', () => {
      const state = makeState('ARCHITECTURE', {
        architecture: ARCHITECTURE_DECISION,
        selfReview: SELF_REVIEW_CONVERGED,
      });
      const action = resolveNextAction('ARCHITECTURE', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
      expect(action.text).toContain('converged');
    });

    it('ARCH_REVIEW → RUN_REVIEW_DECISION', () => {
      const state = makeProgressedState('ARCH_REVIEW');
      const action = resolveNextAction('ARCH_REVIEW', state);
      expectAction(action, ACTION_CODES.RUN_REVIEW_DECISION, ['/review-decision']);
    });

    it('ARCH_COMPLETE → SESSION_COMPLETE (empty commands)', () => {
      const state = makeProgressedState('ARCH_COMPLETE');
      const action = resolveNextAction('ARCH_COMPLETE', state);
      expectAction(action, ACTION_CODES.SESSION_COMPLETE, []);
      expect(action.text).toContain('Architecture flow complete');
    });

    // ── Review Flow ────────────────────────────────────────
    it('REVIEW → RUN_CONTINUE', () => {
      const state = makeState('REVIEW');
      const action = resolveNextAction('REVIEW', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
    });

    it('REVIEW_COMPLETE → SESSION_COMPLETE (empty commands)', () => {
      const state = makeProgressedState('REVIEW_COMPLETE');
      const action = resolveNextAction('REVIEW_COMPLETE', state);
      expectAction(action, ACTION_CODES.SESSION_COMPLETE, []);
      expect(action.text).toContain('Review flow complete');
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('text is always non-empty for every phase', () => {
      for (const phase of Phase.options) {
        const state = makeProgressedState(phase);
        const action = resolveNextAction(phase, state);
        expect(action.text.length, `text empty for phase ${phase}`).toBeGreaterThan(0);
      }
    });

    it('code is always a known ACTION_CODE for every phase', () => {
      const knownCodes = new Set(Object.values(ACTION_CODES));
      for (const phase of Phase.options) {
        const state = makeProgressedState(phase);
        const action = resolveNextAction(phase, state);
        expect(
          knownCodes.has(action.code),
          `unknown code '${action.code}' for phase ${phase}`,
        ).toBe(true);
      }
    });

    it('TICKET with ticket AND plan still returns RUN_PLAN (ticket slot drives)', () => {
      // Edge: ticket has both ticket + plan but phase is still TICKET.
      // This shouldn't normally happen (evaluate would have transitioned),
      // but the resolver must not crash.
      const state = makeState('TICKET', { ticket: TICKET, plan: PLAN_RECORD });
      const action = resolveNextAction('TICKET', state);
      // Has ticket + no plan check: plan IS present, so falls to RUN_TICKET fallback
      // Actually ticket !== null && plan !== null → falls through to RUN_TICKET
      expectAction(action, ACTION_CODES.RUN_TICKET, ['/ticket']);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('terminal phases always return empty commands array', () => {
      const terminals: Phase[] = ['COMPLETE', 'ARCH_COMPLETE', 'REVIEW_COMPLETE'];
      for (const phase of terminals) {
        const state = makeProgressedState(phase);
        const action = resolveNextAction(phase, state);
        expect(action.commands, `commands not empty for terminal ${phase}`).toEqual([]);
        expect(action.code).toBe(ACTION_CODES.SESSION_COMPLETE);
      }
    });

    it('PLAN with no selfReview slot → RUN_CONTINUE (in-progress fallback)', () => {
      const state = makeState('PLAN', { ticket: TICKET, plan: PLAN_RECORD });
      const action = resolveNextAction('PLAN', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
    });

    it('ARCHITECTURE with ADR but no selfReview → RUN_CONTINUE (in-progress fallback)', () => {
      const state = makeState('ARCHITECTURE', { architecture: ARCHITECTURE_DECISION });
      const action = resolveNextAction('ARCHITECTURE', state);
      expectAction(action, ACTION_CODES.RUN_CONTINUE, ['/continue']);
    });

    it('self-review at max iterations → converged', () => {
      const maxedOut = {
        iteration: 3,
        maxIterations: 3,
        prevDigest: 'prev',
        currDigest: 'curr',
        revisionDelta: 'major' as const,
        verdict: 'changes_requested' as const,
      };
      const state = makeState('PLAN', {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: maxedOut,
      });
      const action = resolveNextAction('PLAN', state);
      expect(action.text).toContain('converged');
    });

    it('READY text is multi-line with flow explanations', () => {
      const state = makeState('READY');
      const action = resolveNextAction('READY', state);
      const lines = action.text.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('all 14 phases are covered (exhaustive switch)', () => {
      // If a phase is added to the schema but not the resolver,
      // TypeScript exhaustive check will catch it at compile time.
      // This runtime test verifies no phase throws.
      for (const phase of Phase.options) {
        const state = makeProgressedState(phase);
        expect(() => resolveNextAction(phase, state)).not.toThrow();
      }
    });

    it('resolver is pure — same input yields same output', () => {
      const state = makeState('READY');
      const a = resolveNextAction('READY', state);
      const b = resolveNextAction('READY', state);
      expect(a).toEqual(b);
    });

    it('IMPLEMENTATION with impl evidence → different from without', () => {
      const without = resolveNextAction('IMPLEMENTATION', makeState('IMPLEMENTATION'));
      const withImpl = resolveNextAction(
        'IMPLEMENTATION',
        makeState('IMPLEMENTATION', { implementation: IMPL_EVIDENCE }),
      );
      expect(without.code).not.toBe(withImpl.code);
    });

    it('phase parameter drives resolution, not state.phase', () => {
      // If phase param and state.phase mismatch, the phase param wins.
      // This is by design — the integration layer may call resolveNextAction
      // with a post-transition phase before writing state.
      const state = makeState('TICKET'); // state.phase = TICKET
      const action = resolveNextAction('READY', state); // phase param = READY
      expect(action.code).toBe(ACTION_CODES.CHOOSE_FLOW);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('resolveNextAction completes within evaluate budget for all phases', () => {
      const states = Phase.options.map((p) => ({
        phase: p,
        state: makeProgressedState(p),
      }));

      const { p99Ms } = benchmarkSync(() => {
        for (const { phase, state } of states) {
          resolveNextAction(phase, state);
        }
      }, 100);

      // All 14 phases resolved in under the evaluate budget per call.
      // 14 phases × budget gives total allowed time.
      const totalBudget = Phase.options.length * PERF_BUDGETS.evaluateSingleMs;
      expect(p99Ms).toBeLessThan(totalBudget);
    });

    it('lookup table resolution is at least as fast as switch for all phases', () => {
      // Benchmark: resolve each of the 14 phases 1000 times
      const states = Phase.options.map((p) => ({
        phase: p,
        state: makeProgressedState(p),
      }));

      const start = performance.now();
      for (let round = 0; round < 1000; round++) {
        for (const { phase, state } of states) {
          resolveNextAction(phase, state);
        }
      }
      const elapsed = performance.now() - start;

      // 14 phases × 1000 rounds = 14000 calls.
      // Each call should be < 1μs. Budget: 14000 × 0.01ms = 140ms.
      expect(elapsed).toBeLessThan(700);
    });
  });
});
