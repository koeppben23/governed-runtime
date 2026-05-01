import { describe, it, expect } from 'vitest';
import { TRANSITIONS, USER_GATES, TERMINAL, resolveTransition } from '../machine/topology.js';
import { Event, type Phase, type Event as EventType } from '../state/schema.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';

describe('topology', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    // Ticket flow forward transitions
    it('resolves READY + TICKET_SELECTED → TICKET', () => {
      expect(resolveTransition('READY', 'TICKET_SELECTED')).toBe('TICKET');
    });

    it('resolves TICKET + PLAN_READY → PLAN', () => {
      expect(resolveTransition('TICKET', 'PLAN_READY')).toBe('PLAN');
    });

    it('resolves PLAN + SELF_REVIEW_MET → PLAN_REVIEW', () => {
      expect(resolveTransition('PLAN', 'SELF_REVIEW_MET')).toBe('PLAN_REVIEW');
    });

    it('resolves PLAN_REVIEW + APPROVE → VALIDATION', () => {
      expect(resolveTransition('PLAN_REVIEW', 'APPROVE')).toBe('VALIDATION');
    });

    it('resolves VALIDATION + ALL_PASSED → IMPLEMENTATION', () => {
      expect(resolveTransition('VALIDATION', 'ALL_PASSED')).toBe('IMPLEMENTATION');
    });

    it('resolves IMPLEMENTATION + IMPL_COMPLETE → IMPL_REVIEW', () => {
      expect(resolveTransition('IMPLEMENTATION', 'IMPL_COMPLETE')).toBe('IMPL_REVIEW');
    });

    it('resolves IMPL_REVIEW + REVIEW_MET → EVIDENCE_REVIEW', () => {
      expect(resolveTransition('IMPL_REVIEW', 'REVIEW_MET')).toBe('EVIDENCE_REVIEW');
    });

    it('resolves EVIDENCE_REVIEW + APPROVE → COMPLETE', () => {
      expect(resolveTransition('EVIDENCE_REVIEW', 'APPROVE')).toBe('COMPLETE');
    });

    // Architecture flow forward transitions
    it('resolves READY + ARCHITECTURE_SELECTED → ARCHITECTURE', () => {
      expect(resolveTransition('READY', 'ARCHITECTURE_SELECTED')).toBe('ARCHITECTURE');
    });

    it('resolves ARCHITECTURE + SELF_REVIEW_MET → ARCH_REVIEW', () => {
      expect(resolveTransition('ARCHITECTURE', 'SELF_REVIEW_MET')).toBe('ARCH_REVIEW');
    });

    it('resolves ARCH_REVIEW + APPROVE → ARCH_COMPLETE', () => {
      expect(resolveTransition('ARCH_REVIEW', 'APPROVE')).toBe('ARCH_COMPLETE');
    });

    // Review flow forward transitions
    it('resolves READY + REVIEW_SELECTED → REVIEW', () => {
      expect(resolveTransition('READY', 'REVIEW_SELECTED')).toBe('REVIEW');
    });

    it('resolves REVIEW + REVIEW_DONE → REVIEW_COMPLETE', () => {
      expect(resolveTransition('REVIEW', 'REVIEW_DONE')).toBe('REVIEW_COMPLETE');
    });

    // Backward transitions (ticket flow)
    it('resolves all ticket-flow backward transitions', () => {
      expect(resolveTransition('PLAN_REVIEW', 'CHANGES_REQUESTED')).toBe('PLAN');
      expect(resolveTransition('PLAN_REVIEW', 'REJECT')).toBe('TICKET');
      expect(resolveTransition('EVIDENCE_REVIEW', 'CHANGES_REQUESTED')).toBe('IMPLEMENTATION');
      expect(resolveTransition('EVIDENCE_REVIEW', 'REJECT')).toBe('TICKET');
      expect(resolveTransition('VALIDATION', 'CHECK_FAILED')).toBe('PLAN');
    });

    // Backward transitions (architecture flow)
    it('resolves all architecture-flow backward transitions', () => {
      expect(resolveTransition('ARCH_REVIEW', 'CHANGES_REQUESTED')).toBe('ARCHITECTURE');
      expect(resolveTransition('ARCH_REVIEW', 'REJECT')).toBe('READY');
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('returns undefined for invalid phase+event combo', () => {
      expect(resolveTransition('TICKET', 'APPROVE')).toBeUndefined();
      expect(resolveTransition('PLAN', 'APPROVE')).toBeUndefined();
      expect(resolveTransition('IMPLEMENTATION', 'ALL_PASSED')).toBeUndefined();
      expect(resolveTransition('READY', 'APPROVE')).toBeUndefined();
    });

    it('returns undefined for all events at COMPLETE', () => {
      const events: EventType[] = [
        'TICKET_SELECTED',
        'ARCHITECTURE_SELECTED',
        'REVIEW_SELECTED',
        'PLAN_READY',
        'SELF_REVIEW_MET',
        'SELF_REVIEW_PENDING',
        'APPROVE',
        'CHANGES_REQUESTED',
        'REJECT',
        'ALL_PASSED',
        'CHECK_FAILED',
        'IMPL_COMPLETE',
        'REVIEW_MET',
        'REVIEW_PENDING',
        'REVIEW_DONE',
        'ERROR',
        'ABORT',
      ];
      for (const event of events) {
        expect(resolveTransition('COMPLETE', event)).toBeUndefined();
      }
    });

    it('returns undefined for all events at ARCH_COMPLETE', () => {
      const events: Event[] = [
        'APPROVE',
        'CHANGES_REQUESTED',
        'REJECT',
        'SELF_REVIEW_MET',
        'ERROR',
      ];
      for (const event of events) {
        expect(resolveTransition('ARCH_COMPLETE', event)).toBeUndefined();
      }
    });

    it('returns undefined for all events at REVIEW_COMPLETE', () => {
      const events: Event[] = ['APPROVE', 'REVIEW_DONE', 'ERROR'];
      for (const event of events) {
        expect(resolveTransition('REVIEW_COMPLETE', event)).toBeUndefined();
      }
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('ERROR loops back to same phase for guard-based phases', () => {
      const phasesWithError: Phase[] = [
        'TICKET',
        'PLAN',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'ARCHITECTURE',
        'REVIEW',
      ];
      for (const phase of phasesWithError) {
        expect(resolveTransition(phase, 'ERROR')).toBe(phase);
      }
    });

    it('user gates have no ERROR event', () => {
      expect(resolveTransition('PLAN_REVIEW', 'ERROR')).toBeUndefined();
      expect(resolveTransition('EVIDENCE_REVIEW', 'ERROR')).toBeUndefined();
      expect(resolveTransition('ARCH_REVIEW', 'ERROR')).toBeUndefined();
    });

    it('READY has no ERROR event (command-driven)', () => {
      expect(resolveTransition('READY', 'ERROR')).toBeUndefined();
    });

    it('all terminal phases have empty transition maps', () => {
      for (const phase of ['COMPLETE', 'ARCH_COMPLETE', 'REVIEW_COMPLETE'] as Phase[]) {
        const map = TRANSITIONS.get(phase);
        expect(map).toBeDefined();
        expect(map!.size).toBe(0);
      }
    });

    it('transition table covers all 14 phases', () => {
      const phases: Phase[] = [
        'READY',
        'TICKET',
        'PLAN',
        'PLAN_REVIEW',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'EVIDENCE_REVIEW',
        'COMPLETE',
        'ARCHITECTURE',
        'ARCH_REVIEW',
        'ARCH_COMPLETE',
        'REVIEW',
        'REVIEW_COMPLETE',
      ];
      for (const phase of phases) {
        expect(TRANSITIONS.has(phase)).toBe(true);
      }
      expect(TRANSITIONS.size).toBe(14);
    });

    it('self-loop: PLAN + SELF_REVIEW_PENDING → PLAN', () => {
      expect(resolveTransition('PLAN', 'SELF_REVIEW_PENDING')).toBe('PLAN');
    });

    it('self-loop: ARCHITECTURE + SELF_REVIEW_PENDING → ARCHITECTURE', () => {
      expect(resolveTransition('ARCHITECTURE', 'SELF_REVIEW_PENDING')).toBe('ARCHITECTURE');
    });

    it('self-loop: IMPL_REVIEW + REVIEW_PENDING → IMPL_REVIEW', () => {
      expect(resolveTransition('IMPL_REVIEW', 'REVIEW_PENDING')).toBe('IMPL_REVIEW');
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('USER_GATES contains exactly PLAN_REVIEW, EVIDENCE_REVIEW, and ARCH_REVIEW', () => {
      expect(USER_GATES.size).toBe(3);
      expect(USER_GATES.has('PLAN_REVIEW')).toBe(true);
      expect(USER_GATES.has('EVIDENCE_REVIEW')).toBe(true);
      expect(USER_GATES.has('ARCH_REVIEW')).toBe(true);
    });

    it('TERMINAL contains exactly COMPLETE, ARCH_COMPLETE, and REVIEW_COMPLETE', () => {
      expect(TERMINAL.size).toBe(3);
      expect(TERMINAL.has('COMPLETE')).toBe(true);
      expect(TERMINAL.has('ARCH_COMPLETE')).toBe(true);
      expect(TERMINAL.has('REVIEW_COMPLETE')).toBe(true);
    });

    it('no phase appears as both a user gate and terminal', () => {
      for (const phase of USER_GATES) {
        expect(TERMINAL.has(phase)).toBe(false);
      }
    });

    it('READY has exactly 3 outgoing transitions (one per flow)', () => {
      const readyMap = TRANSITIONS.get('READY');
      expect(readyMap).toBeDefined();
      expect(readyMap!.size).toBe(3);
    });

    it('Event enum is covered by topology or documented topology-bypass handling', () => {
      const transitionEvents = new Set<EventType>();
      for (const transitionMap of TRANSITIONS.values()) {
        for (const event of transitionMap.keys()) {
          transitionEvents.add(event);
        }
      }

      const topologyBypassEvents: EventType[] = ['ABORT'];
      expect([...transitionEvents, ...topologyBypassEvents].sort()).toEqual(
        [...Event.options].sort(),
      );
    });

    it('every non-terminal, non-gate, non-READY phase has at least one outgoing transition', () => {
      const phases: Phase[] = [
        'TICKET',
        'PLAN',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'ARCHITECTURE',
        'REVIEW',
      ];
      for (const phase of phases) {
        const map = TRANSITIONS.get(phase);
        expect(map).toBeDefined();
        expect(map!.size).toBeGreaterThan(0);
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it(`transition lookup < ${PERF_BUDGETS.guardPredicateMs}ms (p99)`, () => {
      const result = benchmarkSync(() => {
        resolveTransition('VALIDATION', 'ALL_PASSED');
      });
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.guardPredicateMs);
    });
  });
});
