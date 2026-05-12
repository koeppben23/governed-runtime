import { describe, it, expect } from 'vitest';
import {
  bySession,
  byPhase,
  byPhases,
  byActor,
  byKind,
  byEvent,
  byTimeRange,
  byDetail,
  allOf,
  anyOf,
  not,
  filterEvents,
  sessionEvents,
  transitionEvents,
  toolCallEvents,
  errorEvents,
  decisionEvents,
  decisionReceipts,
  distinctSessions,
  countByKind,
  countByPhase,
  timeSpan,
} from './query.js';
import type { AuditEvent } from '../state/evidence.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';
import { SESSION_ID, TS1, TS2, TS3, makeAuditEvent } from './audit-test-helpers.js';
describe('audit query', () => {
  // ─── Shared events for query tests ─────────────────────────
  const events: AuditEvent[] = [
    makeAuditEvent({
      id: 'e1',
      sessionId: 'sess-a',
      phase: 'TICKET',
      event: 'lifecycle:session_created',
      timestamp: TS1,
      actor: 'system',
    }),
    makeAuditEvent({
      id: 'e2',
      sessionId: 'sess-a',
      phase: 'PLAN',
      event: 'transition:TICKET_SET',
      timestamp: TS1,
      actor: 'machine',
    }),
    makeAuditEvent({
      id: 'e3',
      sessionId: 'sess-a',
      phase: 'PLAN',
      event: 'tool_call:flowguard_plan',
      timestamp: TS2,
      actor: 'user-1',
    }),
    makeAuditEvent({
      id: 'e4',
      sessionId: 'sess-b',
      phase: 'TICKET',
      event: 'lifecycle:session_created',
      timestamp: TS2,
      actor: 'system',
    }),
    makeAuditEvent({
      id: 'e5',
      sessionId: 'sess-a',
      phase: 'VALIDATION',
      event: 'error:CHECK_TIMEOUT',
      timestamp: TS3,
      actor: 'machine',
      detail: { kind: 'error', code: 'CHECK_TIMEOUT' },
    }),
    makeAuditEvent({
      id: 'e6',
      sessionId: 'sess-a',
      phase: 'PLAN_REVIEW',
      event: 'decision:DEC-001',
      timestamp: TS3,
      actor: 'human',
      detail: {
        kind: 'decision',
        decisionId: 'DEC-001',
        decisionSequence: 1,
        gatePhase: 'PLAN_REVIEW',
        verdict: 'approve',
        rationale: 'looks good',
        decidedBy: 'reviewer-1',
        decidedAt: TS3,
        fromPhase: 'PLAN_REVIEW',
        toPhase: 'VALIDATION',
        transitionEvent: 'APPROVE',
        policyMode: 'team',
      },
    }),
  ];

  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('bySession filters by session ID', () => {
      const result = filterEvents(events, bySession('sess-a'));
      expect(result).toHaveLength(5);
      expect(result.every((e) => e.sessionId === 'sess-a')).toBe(true);
    });

    it('byPhase filters by exact phase', () => {
      const result = filterEvents(events, byPhase('PLAN'));
      expect(result).toHaveLength(2);
    });

    it('byKind filters by event kind prefix', () => {
      const result = filterEvents(events, byKind('transition'));
      expect(result).toHaveLength(1);
      expect(result[0]!.event).toBe('transition:TICKET_SET');
    });

    it('byEvent filters by exact event name', () => {
      const result = filterEvents(events, byEvent('lifecycle:session_created'));
      expect(result).toHaveLength(2);
    });

    it('byActor filters by actor', () => {
      const result = filterEvents(events, byActor('system'));
      expect(result).toHaveLength(2);
    });

    it('sessionEvents returns events for a session', () => {
      expect(sessionEvents(events, 'sess-b')).toHaveLength(1);
    });

    it('transitionEvents returns only transition events', () => {
      const result = transitionEvents(events);
      expect(result).toHaveLength(1);
    });

    it('toolCallEvents returns only tool call events', () => {
      const result = toolCallEvents(events);
      expect(result).toHaveLength(1);
      expect(result[0]!.event).toBe('tool_call:flowguard_plan');
    });

    it('errorEvents returns only error events', () => {
      const result = errorEvents(events);
      expect(result).toHaveLength(1);
    });

    it('decisionEvents returns only decision events', () => {
      const result = decisionEvents(events);
      expect(result).toHaveLength(1);
      expect(result[0]!.event).toBe('decision:DEC-001');
    });

    it('decisionReceipts extracts structured receipt fields', () => {
      const receipts = decisionReceipts(events);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.decisionId).toBe('DEC-001');
      expect(receipts[0]!.decisionSequence).toBe(1);
      expect(receipts[0]!.verdict).toBe('approve');
      expect(receipts[0]!.policyMode).toBe('team');
    });

    it('distinctSessions returns unique session IDs', () => {
      const ids = distinctSessions(events);
      expect(ids).toHaveLength(2);
      expect(ids).toContain('sess-a');
      expect(ids).toContain('sess-b');
    });

    it('countByKind counts events by kind prefix', () => {
      const counts = countByKind(events);
      expect(counts.lifecycle).toBe(2);
      expect(counts.transition).toBe(1);
      expect(counts.tool_call).toBe(1);
      expect(counts.error).toBe(1);
      expect(counts.decision).toBe(1);
    });

    it('countByPhase counts events per phase', () => {
      const counts = countByPhase(events);
      expect(counts.TICKET).toBe(2);
      expect(counts.PLAN).toBe(2);
      expect(counts.VALIDATION).toBe(1);
    });

    it('timeSpan returns first and last timestamps', () => {
      const span = timeSpan(events);
      expect(span).not.toBeNull();
      expect(span!.first).toBe(TS1);
      expect(span!.last).toBe(TS3);
      expect(span!.durationMs).toBe(120000); // 2 minutes
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('empty events array returns empty results', () => {
      expect(filterEvents([], byPhase('PLAN'))).toHaveLength(0);
      expect(transitionEvents([])).toHaveLength(0);
      expect(decisionReceipts([])).toHaveLength(0);
      expect(distinctSessions([])).toHaveLength(0);
      expect(countByKind([])).toEqual({});
    });

    it('no matching events returns empty', () => {
      expect(filterEvents(events, bySession('nonexistent'))).toHaveLength(0);
      expect(filterEvents(events, byPhase('COMPLETE'))).toHaveLength(0);
    });

    it('timeSpan with empty events returns null', () => {
      expect(timeSpan([])).toBeNull();
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it("byTimeRange with only 'from' (open-ended to)", () => {
      const result = filterEvents(events, byTimeRange(TS2, null));
      expect(result).toHaveLength(4); // TS2 and TS3 events
    });

    it("byTimeRange with only 'to' (open-ended from)", () => {
      const result = filterEvents(events, byTimeRange(null, TS1));
      expect(result).toHaveLength(2); // Only TS1 events
    });

    it('byTimeRange with both bounds', () => {
      const result = filterEvents(events, byTimeRange(TS2, TS2));
      expect(result).toHaveLength(2); // Exactly TS2 events
    });

    it('byTimeRange with null both → returns all', () => {
      const result = filterEvents(events, byTimeRange(null, null));
      expect(result).toHaveLength(6);
    });

    it('byPhases filters by multiple phases (Set-based)', () => {
      const result = filterEvents(events, byPhases(['TICKET', 'VALIDATION']));
      expect(result).toHaveLength(3);
    });

    it('byDetail matches on a specific detail field value', () => {
      const result = filterEvents(events, byDetail('code', 'CHECK_TIMEOUT'));
      expect(result).toHaveLength(1);
      expect(result[0]!.event).toBe('error:CHECK_TIMEOUT');
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('allOf combines filters with AND logic', () => {
      const result = filterEvents(events, allOf(bySession('sess-a'), byPhase('PLAN')));
      expect(result).toHaveLength(2);
    });

    it('anyOf combines filters with OR logic', () => {
      const result = filterEvents(events, anyOf(byPhase('TICKET'), byPhase('VALIDATION')));
      expect(result).toHaveLength(3);
    });

    it('not negates a filter', () => {
      const result = filterEvents(events, not(bySession('sess-a')));
      expect(result).toHaveLength(1);
      expect(result[0]!.sessionId).toBe('sess-b');
    });

    it('allOf with zero filters matches everything', () => {
      const result = filterEvents(events, allOf());
      expect(result).toHaveLength(6);
    });

    it('decisionReceipts skips malformed decision payloads', () => {
      const malformed = makeAuditEvent({
        id: 'bad-decision',
        event: 'decision:DEC-999',
        detail: { kind: 'decision', decisionId: 999 as unknown as string },
      });
      const receipts = decisionReceipts([...events, malformed]);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.decisionId).toBe('DEC-001');
    });

    it('anyOf with zero filters matches nothing', () => {
      const result = filterEvents(events, anyOf());
      expect(result).toHaveLength(0);
    });

    it('complex composed query', () => {
      // "sess-a events that are either transitions or errors"
      const filter = allOf(bySession('sess-a'), anyOf(byKind('transition'), byKind('error')));
      const result = filterEvents(events, filter);
      expect(result).toHaveLength(2);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it(`filterEvents with 10000 events < ${PERF_BUDGETS.filterEvents10000Ms}ms (p95)`, () => {
      const largeTrail: AuditEvent[] = Array.from({ length: 10000 }, (_, i) =>
        makeAuditEvent({
          id: `perf-${i}`,
          sessionId: i % 2 === 0 ? 'sess-a' : 'sess-b',
          phase: i % 3 === 0 ? 'PLAN' : 'TICKET',
          event: `transition:EVENT_${i}`,
        }),
      );
      const { p95Ms } = benchmarkSync(
        () => filterEvents(largeTrail, allOf(bySession('sess-a'), byPhase('PLAN'))),
        50,
        10,
      );
      expect(p95Ms).toBeLessThan(PERF_BUDGETS.filterEvents10000Ms);
    });
  });
});

// =============================================================================
// audit/summary
// =============================================================================
