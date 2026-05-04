/**
 * @module ticket.test
 * @description Rail unit tests for /ticket — task description recording.
 *
 * P10b: tests fail-closed input validation, downstream evidence clearing,
 * and external references preservation.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it } from 'vitest';
import { executeTicket, type TicketInput } from './ticket.js';
import { makeState, FIXED_TIME } from '../__fixtures__.js';
import type { RailContext } from './types.js';

const ctx: RailContext = {
  now: () => FIXED_TIME,
  digest: (s: string) => `sha256:${s.length}`,
  policy: {},
};

function ticketInput(overrides?: Partial<TicketInput>): TicketInput {
  return { text: 'Fix the auth bug', source: 'user', ...overrides };
}

describe('ticket rail', () => {
  // ── HAPPY ──────────────────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('records ticket from READY and advances to TICKET phase', () => {
      const state = makeState('READY');
      const result = executeTicket(state, ticketInput(), ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.phase).toBe('TICKET');
        expect(result.state.ticket?.text).toBe('Fix the auth bug');
        expect(result.state.ticket?.source).toBe('user');
        expect(result.state.ticket?.digest).toBe('sha256:16');
        expect(result.state.plan).toBeNull();
        expect(result.state.selfReview).toBeNull();
        expect(result.state.implementation).toBeNull();
      }
    });
  });

  // ── BAD ────────────────────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks when not in READY phase (phase gate)', () => {
      const state = makeState('COMPLETE');
      const result = executeTicket(state, ticketInput(), ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('COMMAND_NOT_ALLOWED');
        expect(result.reason).toContain('/ticket');
      }
    });

    it('blocks on empty ticket text', () => {
      const state = makeState('READY');
      const result = executeTicket(state, ticketInput({ text: '   ' }), ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') {
        expect(result.code).toBe('EMPTY_TICKET');
      }
    });
  });

  // ── CORNER ─────────────────────────────────────────────────────────────
  describe('CORNER', () => {
    it('preserves external references and inputOrigin', () => {
      const state = makeState('READY');
      const result = executeTicket(
        state,
        ticketInput({
          source: 'external',
          inputOrigin: 'external_reference',
          references: [{ ref: 'https://jira.example.com/PROJ-123', type: 'ticket' }],
        }),
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket?.source).toBe('external');
        expect(result.state.ticket?.inputOrigin).toBe('external_reference');
        expect(result.state.ticket?.references).toHaveLength(1);
      }
    });
  });

  // ── EDGE ───────────────────────────────────────────────────────────────
  describe('EDGE', () => {
    it('accepts very long ticket text without truncation', () => {
      const state = makeState('READY');
      const longText = 'A'.repeat(10_000);
      const result = executeTicket(state, ticketInput({ text: longText }), ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket?.text).toBe(longText);
      }
    });
  });
});
