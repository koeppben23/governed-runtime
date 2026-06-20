import { describe, it, expect } from 'vitest';
import { executeTicket } from '../rails/ticket.js';
import { createTestContext } from '../testing.js';
import {
  makeState,
  makeProgressedState,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
} from '../__fixtures__.js';

const ctx = createTestContext();

describe('ticket rail', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('records ticket evidence in TICKET phase', () => {
      const state = makeState('TICKET');
      const result = executeTicket(state, { text: 'Fix auth bug', source: 'user' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket).not.toBeNull();
        expect(result.state.ticket!.text).toBe('Fix auth bug');
        expect(result.state.ticket!.source).toBe('user');
        expect(result.state.ticket!.digest).toBeDefined();
      }
    });

    it('clears downstream evidence on re-ticketing', () => {
      const state = makeState('TICKET', { plan: PLAN_RECORD, selfReview: SELF_REVIEW_CONVERGED });
      const result = executeTicket(state, { text: 'New task', source: 'user' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.plan).toBeNull();
        expect(result.state.selfReview).toBeNull();
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('blocks on empty text', () => {
      const result = executeTicket(makeState('TICKET'), { text: '', source: 'user' }, ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('EMPTY_TICKET');
    });

    it('blocks on whitespace-only text', () => {
      const result = executeTicket(makeState('TICKET'), { text: '   ', source: 'user' }, ctx);
      expect(result.kind).toBe('blocked');
    });

    it('blocks in wrong phase', () => {
      const result = executeTicket(makeState('PLAN'), { text: 'task', source: 'user' }, ctx);
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('blocks at COMPLETE', () => {
      const result = executeTicket(
        makeProgressedState('COMPLETE'),
        { text: 'task', source: 'user' },
        ctx,
      );
      expect(result.kind).toBe('blocked');
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('source can be external', () => {
      const result = executeTicket(makeState('TICKET'), { text: 'task', source: 'external' }, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.state.ticket!.source).toBe('external');
    });

    it('stores inputOrigin when provided', () => {
      const result = executeTicket(
        makeState('TICKET'),
        { text: 'Fix login redirect', source: 'external', inputOrigin: 'external_reference' },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.inputOrigin).toBe('external_reference');
      }
    });

    it('stores references array with Jira URL', () => {
      const ref = {
        ref: 'https://jira.example.com/browse/PROJ-123',
        type: 'ticket' as const,
        title: 'PROJ-123: Fix login redirect',
        source: 'jira',
        extractedAt: '2026-01-15T10:00:00.000Z',
      };
      const result = executeTicket(
        makeState('TICKET'),
        {
          text: 'Fix login redirect after token expiry',
          source: 'external',
          inputOrigin: 'external_reference',
          references: [ref],
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.references).toHaveLength(1);
        expect(result.state.ticket!.references![0]!.ref).toBe(ref.ref);
        expect(result.state.ticket!.references![0]!.type).toBe('ticket');
        expect(result.state.ticket!.references![0]!.title).toBe(ref.title);
        expect(result.state.ticket!.references![0]!.source).toBe('jira');
        expect(result.state.ticket!.references![0]!.extractedAt).toBe(ref.extractedAt);
      }
    });

    it('stores multiple references (Jira + Confluence + GitHub)', () => {
      const refs = [
        {
          ref: 'https://jira.example.com/PROJ-42',
          type: 'ticket' as const,
          source: 'jira',
          title: 'PROJ-42',
        },
        {
          ref: 'https://confluence.example.com/SPEC-1',
          type: 'doc' as const,
          source: 'confluence',
          title: 'Spec v2',
        },
        {
          ref: 'https://github.com/org/repo/issues/7',
          type: 'issue' as const,
          source: 'github',
          title: 'Issue #7',
        },
      ];
      const result = executeTicket(
        makeState('TICKET'),
        { text: 'Implement feature X', source: 'external', inputOrigin: 'mixed', references: refs },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.references).toHaveLength(3);
        expect(result.state.ticket!.inputOrigin).toBe('mixed');
      }
    });

    it('sets inputOrigin to manual_text for manually typed tickets', () => {
      const result = executeTicket(
        makeState('TICKET'),
        { text: 'Just a text description', source: 'user', inputOrigin: 'manual_text' },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.inputOrigin).toBe('manual_text');
        expect(result.state.ticket!.references).toBeUndefined();
      }
    });

    it('normalizes away empty references array', () => {
      const result = executeTicket(
        makeState('TICKET'),
        { text: 'Task', source: 'user', references: [] },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.references).toBeUndefined();
      }
    });

    it('digest only covers text, not references or inputOrigin', () => {
      const text = 'Fix the auth bug';
      const result1 = executeTicket(makeState('TICKET'), { text, source: 'user' }, ctx);
      const result2 = executeTicket(
        makeState('TICKET'),
        {
          text,
          source: 'external',
          inputOrigin: 'external_reference',
          references: [
            { ref: 'https://jira.example.com/PROJ-123', type: 'ticket' as const, source: 'jira' },
          ],
        },
        ctx,
      );
      expect(result1.kind).toBe('ok');
      expect(result2.kind).toBe('ok');
      if (result1.kind === 'ok' && result2.kind === 'ok') {
        expect(result1.state.ticket!.digest).toBe(result2.state.ticket!.digest);
      }
    });

    it('reference without type defaults to undefined (not other)', () => {
      const result = executeTicket(
        makeState('TICKET'),
        {
          text: 'Task',
          source: 'external',
          references: [{ ref: 'https://example.com/ticket/1' }],
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.references![0]!.type).toBeUndefined();
      }
    });

    it('reference without extractedAt is stored as-is (content not fetched)', () => {
      const result = executeTicket(
        makeState('TICKET'),
        {
          text: 'Content could not be extracted from: https://jira.example.com/PROJ-999',
          source: 'external',
          inputOrigin: 'external_reference',
          references: [
            { ref: 'https://jira.example.com/PROJ-999', type: 'ticket' as const, source: 'jira' },
          ],
        },
        ctx,
      );
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.state.ticket!.references![0]!.extractedAt).toBeUndefined();
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('ticket execution is fast (smoke test)', () => {
      const start = performance.now();
      executeTicket(makeState('TICKET'), { text: 'task', source: 'user' }, ctx);
      expect(performance.now() - start).toBeLessThan(50);
    });

    it('ticket with references is fast (smoke test)', () => {
      const start = performance.now();
      executeTicket(
        makeState('TICKET'),
        {
          text: 'task',
          source: 'external',
          inputOrigin: 'external_reference',
          references: [
            { ref: 'https://jira.example.com/PROJ-1', type: 'ticket' as const },
            { ref: 'https://github.com/org/repo/issues/2', type: 'issue' as const },
            { ref: 'https://confluence.example.com/pages/3', type: 'doc' as const },
          ],
        },
        ctx,
      );
      expect(performance.now() - start).toBeLessThan(50);
    });
  });
});

// ─── MUTATION KILL: blocked detail interpolation ─────────────────────────────

describe('MUTATION: ticket blocked reason detail', () => {
  const mCtx = createTestContext();

  it('ticket COMMAND_NOT_ALLOWED reason contains /ticket and phase', () => {
    const result = executeTicket(makeState('PLAN'), { text: 'task', source: 'user' }, mCtx);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
      expect(result.reason).toContain('/ticket');
      expect(result.reason).toContain('PLAN');
    }
  });

  it('ticket COMMAND_NOT_ALLOWED at COMPLETE includes phase', () => {
    const result = executeTicket(
      makeProgressedState('COMPLETE'),
      { text: 'task', source: 'user' },
      mCtx,
    );
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason).toContain('/ticket');
      expect(result.reason).toContain('COMPLETE');
    }
  });
});

// ─── MUTATION KILL: ticket conditional spreads and phase transition ───────────

describe('MUTATION_KILL ticket', () => {
  it('inputOrigin NOT present when not provided (conditional spread)', () => {
    const state = makeState('TICKET');
    const result = executeTicket(state, { text: 'Fix auth', source: 'user' }, ctx);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // Must NOT have inputOrigin key at all (not undefined value)
      expect('inputOrigin' in result.state.ticket!).toBe(false);
    }
  });

  it('references NOT present when not provided (conditional spread)', () => {
    const state = makeState('TICKET');
    const result = executeTicket(state, { text: 'Fix auth', source: 'user' }, ctx);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect('references' in result.state.ticket!).toBe(false);
    }
  });

  it('references NOT present when empty array provided (empty guard)', () => {
    const state = makeState('TICKET');
    const result = executeTicket(state, { text: 'Fix auth', source: 'user', references: [] }, ctx);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect('references' in result.state.ticket!).toBe(false);
    }
  });

  it('from READY phase: transitions to TICKET with TICKET_SELECTED', () => {
    const state = makeState('READY');
    const result = executeTicket(state, { text: 'Fix auth', source: 'user' }, ctx);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.phase).toBe('TICKET');
      expect(result.transitions.length).toBeGreaterThan(0);
      expect(result.transitions[0]!.event).toBe('TICKET_SELECTED');
      expect(result.transitions[0]!.from).toBe('READY');
      expect(result.transitions[0]!.to).toBe('TICKET');
    }
  });

  it('from TICKET phase: no TICKET_SELECTED transition (already in phase)', () => {
    const state = makeState('TICKET');
    const result = executeTicket(state, { text: 'Fix auth', source: 'user' }, ctx);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // No pre-transition from READY → TICKET
      const ticketSelectedTransitions = result.transitions.filter(
        (t) => t.event === 'TICKET_SELECTED',
      );
      expect(ticketSelectedTransitions).toHaveLength(0);
    }
  });
});
