/**
 * @module abort.test
 * @description Rail unit tests for /abort — emergency session termination.
 *
 * P10b: tests fail-closed abort behavior, idempotency, and audit trail.
 *
 * @test-policy HAPPY, BAD, CORNER, PERF
 */

import { describe, expect, it } from 'vitest';
import { executeAbort, type AbortInput } from './abort.js';
import { makeState, FIXED_TIME } from '../__fixtures__.js';
import type { RailContext } from './types.js';

const ctx: RailContext = {
  now: () => FIXED_TIME,
  digest: (s: string) => `sha256:${s.length}`,
  policy: {},
};

const ABORT_INPUT: AbortInput = { reason: 'Testing abort', actor: 'test-runner' };

describe('abort rail', () => {
  // ── HAPPY ──────────────────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('transitions from TICKET to COMPLETE with ABORTED error', () => {
      const state = makeState('TICKET');
      const result = executeAbort(state, ABORT_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('COMPLETE');
        expect(result.state.error?.code).toBe('ABORTED');
        expect(result.state.error?.message).toBe('Testing abort');
        expect(result.transitions[0].event).toBe('ABORT');
        expect(result.transitions[0].from).toBe('TICKET');
        expect(result.transitions[0].to).toBe('COMPLETE');
      }
    });

    it('transitions from READY to COMPLETE (works from any phase)', () => {
      const state = makeState('READY');
      const result = executeAbort(state, ABORT_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('COMPLETE');
        expect(result.state.error?.code).toBe('ABORTED');
      }
    });
  });

  // ── BAD ────────────────────────────────────────────────────────────────
  describe('BAD', () => {
    it('idempotent when already COMPLETE — returns current state unchanged', () => {
      const state = makeState('COMPLETE', { error: null });
      const result = executeAbort(state, ABORT_INPUT, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('COMPLETE');
        expect(result.state.error).toBeNull();
        expect(result.transitions).toHaveLength(0);
      }
    });
  });

  // ── CORNER ─────────────────────────────────────────────────────────────
  describe('CORNER', () => {
    it('empty reason falls back to default message', () => {
      const state = makeState('TICKET');
      const result = executeAbort(state, { reason: '', actor: 'test' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.error?.message).toBe('Session aborted');
      }
    });
  });
});
