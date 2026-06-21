import { describe, it, expect } from 'vitest';
import { executeAbort } from '../rails/abort.js';
import { createTestContext } from '../testing.js';
import { makeState, makeProgressedState, TICKET, PLAN_RECORD } from '../fixtures.js';

const ctx = createTestContext();

describe('abort rail', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('aborts from any phase to COMPLETE with ABORTED error', () => {
      const phases = [
        'TICKET',
        'PLAN',
        'PLAN_REVIEW',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'EVIDENCE_REVIEW',
      ] as const;
      for (const phase of phases) {
        const state = makeState(phase);
        const result = executeAbort(state, { reason: 'cancelled', actor: 'user' }, ctx);
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
          expect(result.state.phase).toBe('COMPLETE');
          expect(result.state.error?.code).toBe('ABORTED');
        }
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    // Abort doesn't really have "bad" input — it always works
    it('uses default message when reason is empty', () => {
      const result = executeAbort(makeState('TICKET'), { reason: '', actor: 'user' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.error?.message).toBe('Session aborted');
      }
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('idempotent at COMPLETE — returns terminal with no transitions', () => {
      const state = makeProgressedState('COMPLETE');
      const result = executeAbort(state, { reason: 'again', actor: 'user' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('COMPLETE');
        expect(result.transitions.length).toBe(0);
        expect(result.evalResult.kind).toBe('terminal');
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('records ABORT transition bypassing topology', () => {
      const result = executeAbort(makeState('PLAN'), { reason: 'stop', actor: 'ci' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.transitions.length).toBe(1);
        expect(result.transitions[0]!.event).toBe('ABORT');
        expect(result.transitions[0]!.from).toBe('PLAN');
        expect(result.transitions[0]!.to).toBe('COMPLETE');
      }
    });

    it('preserves existing evidence after abort', () => {
      const state = makeState('IMPLEMENTATION', { ticket: TICKET, plan: PLAN_RECORD });
      const result = executeAbort(state, { reason: 'stop', actor: 'user' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket).not.toBeNull();
        expect(result.state.plan).not.toBeNull();
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('abort execution is fast (smoke test)', () => {
      const start = performance.now();
      executeAbort(makeState('PLAN'), { reason: 'stop', actor: 'user' }, ctx);
      expect(performance.now() - start).toBeLessThan(50);
    });
  });
});
