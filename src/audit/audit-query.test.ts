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
import type { AuditEventKind } from './types.js';
describe('audit query', () => {
  // ─── Shared events for query tests ─────────────────────────
  const events: AuditEvent[] = [
    makeAuditEvent({
      id: 'e1',
      hostSessionId: 'sess-a',
      phase: 'TICKET',
      event: 'lifecycle:session_created',
      occurredAt: TS1,
      actor: 'system',
    }),
    makeAuditEvent({
      id: 'e2',
      hostSessionId: 'sess-a',
      phase: 'PLAN',
      event: 'transition:TICKET_SET',
      occurredAt: TS1,
      actor: 'machine',
    }),
    makeAuditEvent({
      id: 'e3',
      hostSessionId: 'sess-a',
      phase: 'PLAN',
      event: 'tool_call:flowguard_plan',
      occurredAt: TS2,
      actor: 'user-1',
    }),
    makeAuditEvent({
      id: 'e4',
      hostSessionId: 'sess-b',
      phase: 'TICKET',
      event: 'lifecycle:session_created',
      occurredAt: TS2,
      actor: 'system',
    }),
    makeAuditEvent({
      id: 'e5',
      hostSessionId: 'sess-a',
      phase: 'VALIDATION',
      event: 'error:CHECK_TIMEOUT',
      occurredAt: TS3,
      actor: 'machine',
      detail: { kind: 'error', code: 'CHECK_TIMEOUT' },
    }),
    makeAuditEvent({
      id: 'e6',
      hostSessionId: 'sess-a',
      phase: 'PLAN_REVIEW',
      event: 'decision:DEC-001',
      occurredAt: TS3,
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
      expect(result.every((e) => e.hostSessionId === 'sess-a')).toBe(true);
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

    it('distinctSessions returns unique FlowGuard session IDs', () => {
      const ids = distinctSessions(events);
      expect(ids).toHaveLength(1);
      expect(ids).toContain(SESSION_ID);
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
      expect(result[0]!.hostSessionId).toBe('sess-b');
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
          hostSessionId: i % 2 === 0 ? 'sess-a' : 'sess-b',
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

  // ─── audit-chain.v3 event-name contract ─────────────────────
  describe('kind discrimination follows the audit-chain.v3 event names', () => {
    // Not every kind names its events `${kind}:...`. state_write and
    // enforcement:denied are the two current exceptions, and byKind must
    // reach them without dropping the prefix-named kinds.
    const KIND_CASES: ReadonlyArray<{ event: string; kind: AuditEventKind }> = [
      { event: 'transition:PLAN_READY', kind: 'transition' },
      { event: 'state_write', kind: 'state_write' },
      { event: 'enforcement:denied', kind: 'enforcement_denied' },
      { event: 'tool_call:flowguard_plan', kind: 'tool_call' },
      { event: 'error:SESSION_ERROR', kind: 'error' },
      { event: 'lifecycle:session_created', kind: 'lifecycle' },
      { event: 'decision:DEC-001', kind: 'decision' },
    ];

    for (const { event, kind } of KIND_CASES) {
      it(`byKind('${kind}') matches "${event}"`, () => {
        // No detail.kind: events appended through the generic review/audit
        // append path carry caller-supplied detail, so the event name has to
        // be sufficient on its own.
        const trail = [makeAuditEvent({ id: 'k1', event, detail: {} })];
        expect(filterEvents(trail, byKind(kind))).toHaveLength(1);
      });
    }

    it('byKind does not confuse enforcement_denied with other enforcement events', () => {
      const trail = [
        makeAuditEvent({ id: 'k1', event: 'enforcement:denied', detail: {} }),
        makeAuditEvent({ id: 'k2', event: 'enforcement:allowed', detail: {} }),
      ];
      const result = filterEvents(trail, byKind('enforcement_denied'));
      expect(result).toHaveLength(1);
      expect(result[0]!.event).toBe('enforcement:denied');
    });

    it('countByKind namespaces every current event-name form', () => {
      const trail = [
        makeAuditEvent({ id: 'c1', event: 'transition:PLAN_READY', detail: {} }),
        makeAuditEvent({ id: 'c2', event: 'state_write', detail: {} }),
        makeAuditEvent({ id: 'c3', event: 'enforcement:denied', detail: {} }),
        makeAuditEvent({ id: 'c4', event: 'error:SESSION_ERROR', detail: {} }),
        makeAuditEvent({ id: 'c5', event: 'review:obligation_created', detail: {} }),
        makeAuditEvent({ id: 'c6', event: 'review:obligation_blocked', detail: {} }),
      ];
      expect(countByKind(trail)).toEqual({
        transition: 1,
        state_write: 1,
        enforcement_denied: 1,
        error: 1,
        // review:* is not an AuditEventKind; it keeps its own namespace.
        review: 2,
      });
    });
  });

  // ─── occurrence time vs. record order ───────────────────────
  describe('timeSpan uses occurrence time, not trail position', () => {
    it('reports the true span when a reconciled event occurred before its predecessor', () => {
      // Legitimate under audit-chain.v3: the trail is ordered by recordedAt,
      // and an outbox event reconciled later may carry an older occurredAt.
      const trail = [
        makeAuditEvent({ id: 't1', event: 'transition:PLAN_READY', occurredAt: TS2 }),
        makeAuditEvent({ id: 't2', event: 'state_write', occurredAt: TS3 }),
        makeAuditEvent({ id: 't3', event: 'tool_call:flowguard_plan', occurredAt: TS1 }),
      ];
      const span = timeSpan(trail);
      expect(span).not.toBeNull();
      expect(span!.first).toBe(TS1);
      expect(span!.last).toBe(TS3);
      expect(span!.durationMs).toBe(120000);
    });

    it('never reports a negative duration', () => {
      const trail = [
        makeAuditEvent({ id: 't1', event: 'state_write', occurredAt: TS3 }),
        makeAuditEvent({ id: 't2', event: 'state_write', occurredAt: TS1 }),
      ];
      expect(timeSpan(trail)!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('is unaffected by input ordering', () => {
      const trail = [
        makeAuditEvent({ id: 't1', event: 'state_write', occurredAt: TS2 }),
        makeAuditEvent({ id: 't2', event: 'state_write', occurredAt: TS1 }),
        makeAuditEvent({ id: 't3', event: 'state_write', occurredAt: TS3 }),
      ];
      expect(timeSpan(trail)).toEqual(timeSpan([...trail].reverse()));
    });

    it('single event spans zero', () => {
      const span = timeSpan([makeAuditEvent({ id: 't1', occurredAt: TS2 })]);
      expect(span).toEqual({ first: TS2, last: TS2, durationMs: 0 });
    });
  });
});

// =============================================================================
// audit/summary
// =============================================================================
