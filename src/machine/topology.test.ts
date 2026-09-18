import { describe, it, expect } from 'vitest';
import {
  FLOW_PHASES,
  TRANSITIONS,
  USER_GATE_PHASES,
  USER_GATES,
  TERMINAL,
  isFlowPhase,
  isFlowPhaseAtOrAfter,
  resolveTransition,
} from '../machine/topology.js';
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

    it('resolves VALIDATION + CHECK_ERRORED → VALIDATION (retry, not re-plan)', () => {
      expect(resolveTransition('VALIDATION', 'CHECK_ERRORED')).toBe('VALIDATION');
    });

    it('resolves IMPLEMENTATION + IMPL_COMPLETE → IMPL_VALIDATION', () => {
      expect(resolveTransition('IMPLEMENTATION', 'IMPL_COMPLETE')).toBe('IMPL_VALIDATION');
    });

    it('resolves IMPL_VALIDATION + ALL_PASSED → IMPL_REVIEW (post-fix checks passed)', () => {
      expect(resolveTransition('IMPL_VALIDATION', 'ALL_PASSED')).toBe('IMPL_REVIEW');
    });

    it('resolves IMPL_VALIDATION + CHECK_FAILED → IMPLEMENTATION (code is wrong, not plan)', () => {
      expect(resolveTransition('IMPL_VALIDATION', 'CHECK_FAILED')).toBe('IMPLEMENTATION');
    });

    it('resolves IMPL_VALIDATION + CHECK_ERRORED → IMPL_VALIDATION (retry)', () => {
      expect(resolveTransition('IMPL_VALIDATION', 'CHECK_ERRORED')).toBe('IMPL_VALIDATION');
    });

    it('resolves IMPLEMENTATION + REDUCED_CEREMONY → EVIDENCE_REVIEW', () => {
      expect(resolveTransition('IMPLEMENTATION', 'REDUCED_CEREMONY')).toBe('EVIDENCE_REVIEW');
    });

    it('resolves IMPL_REVIEW + REVIEW_MET → EVIDENCE_REVIEW', () => {
      expect(resolveTransition('IMPL_REVIEW', 'REVIEW_MET')).toBe('EVIDENCE_REVIEW');
    });

    it('resolves IMPL_REVIEW + CHANGES_REQUESTED → IMPLEMENTATION', () => {
      expect(resolveTransition('IMPL_REVIEW', 'CHANGES_REQUESTED')).toBe('IMPLEMENTATION');
    });

    it('resolves EVIDENCE_REVIEW + APPROVE → EXPORT_READY', () => {
      expect(resolveTransition('EVIDENCE_REVIEW', 'APPROVE')).toBe('EXPORT_READY');
    });

    it('resolves EXPORT_READY + EXPORT_MATERIALIZED → COMPLETE', () => {
      expect(resolveTransition('EXPORT_READY', 'EXPORT_MATERIALIZED')).toBe('COMPLETE');
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
    it('resolves READY + PEER_REVIEW_SELECTED → PEER_REVIEW', () => {
      expect(resolveTransition('READY', 'PEER_REVIEW_SELECTED')).toBe('PEER_REVIEW');
    });

    it('resolves PEER_REVIEW + PEER_REVIEW_DONE → PEER_REVIEW_COMPLETE', () => {
      expect(resolveTransition('PEER_REVIEW', 'PEER_REVIEW_DONE')).toBe('PEER_REVIEW_COMPLETE');
    });

    // Revision transitions (ticket flow)
    it('resolves ticket-flow revision and terminal rejection transitions', () => {
      expect(resolveTransition('PLAN_REVIEW', 'CHANGES_REQUESTED')).toBe('PLAN');
      expect(resolveTransition('PLAN_REVIEW', 'REJECT')).toBe('REJECTED');
      expect(resolveTransition('EVIDENCE_REVIEW', 'CHANGES_REQUESTED')).toBe('IMPLEMENTATION');
      expect(resolveTransition('EVIDENCE_REVIEW', 'REJECT')).toBe('REJECTED');
      expect(resolveTransition('VALIDATION', 'CHECK_FAILED')).toBe('PLAN');
    });

    // Revision transitions (architecture flow)
    it('resolves architecture-flow revision and terminal rejection transitions', () => {
      expect(resolveTransition('ARCH_REVIEW', 'CHANGES_REQUESTED')).toBe('ARCHITECTURE');
      expect(resolveTransition('ARCH_REVIEW', 'REJECT')).toBe('REJECTED');
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
        'PEER_REVIEW_SELECTED',
        'PLAN_READY',
        'SELF_REVIEW_MET',
        'SELF_REVIEW_PENDING',
        'APPROVE',
        'CHANGES_REQUESTED',
        'REJECT',
        'ALL_PASSED',
        'CHECK_FAILED',
        'CHECK_ERRORED',
        'IMPL_COMPLETE',
        'REDUCED_CEREMONY',
        'REVIEW_MET',
        'REVIEW_PENDING',
        'PEER_REVIEW_DONE',
        'EXPORT_MATERIALIZED',
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
      const events: Event[] = ['APPROVE', 'PEER_REVIEW_DONE', 'ERROR'];
      for (const event of events) {
        expect(resolveTransition('PEER_REVIEW_COMPLETE', event)).toBeUndefined();
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
        'PEER_REVIEW',
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
      for (const phase of [
        'COMPLETE',
        'ARCH_COMPLETE',
        'PEER_REVIEW_COMPLETE',
        'REJECTED',
        'ABORTED',
      ] as Phase[]) {
        const map = TRANSITIONS.get(phase);
        expect(map).toBeDefined();
        expect(map!.size).toBe(0);
      }
    });

    it('transition table covers all 18 phases', () => {
      const phases: Phase[] = [
        'READY',
        'TICKET',
        'PLAN',
        'PLAN_REVIEW',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_VALIDATION',
        'IMPL_REVIEW',
        'EVIDENCE_REVIEW',
        'EXPORT_READY',
        'COMPLETE',
        'ARCHITECTURE',
        'ARCH_REVIEW',
        'ARCH_COMPLETE',
        'PEER_REVIEW',
        'PEER_REVIEW_COMPLETE',
        'REJECTED',
        'ABORTED',
      ];
      for (const phase of phases) {
        expect(TRANSITIONS.has(phase)).toBe(true);
      }
      expect(TRANSITIONS.size).toBe(18);
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

    it('USER_GATES mirrors the compile-time USER_GATE_PHASES tuple', () => {
      expect([...USER_GATES].sort()).toEqual([...USER_GATE_PHASES].sort());
    });

    it('TERMINAL contains every terminal position', () => {
      expect(TERMINAL.size).toBe(5);
      expect(TERMINAL.has('COMPLETE')).toBe(true);
      expect(TERMINAL.has('ARCH_COMPLETE')).toBe(true);
      expect(TERMINAL.has('PEER_REVIEW_COMPLETE')).toBe(true);
      expect(TERMINAL.has('REJECTED')).toBe(true);
      expect(TERMINAL.has('ABORTED')).toBe(true);
    });

    it('no phase appears as both a user gate and terminal', () => {
      for (const phase of USER_GATES) {
        expect(TERMINAL.has(phase)).toBe(false);
      }
    });

    it('READY has three flow selections and an explicit abort transition', () => {
      const readyMap = TRANSITIONS.get('READY');
      expect(readyMap).toBeDefined();
      expect(readyMap!.size).toBe(4);
    });

    it('Event enum is covered by topology or documented topology-bypass handling', () => {
      const transitionEvents = new Set<EventType>();
      for (const transitionMap of TRANSITIONS.values()) {
        for (const event of transitionMap.keys()) {
          transitionEvents.add(event);
        }
      }

      expect([...transitionEvents].sort()).toEqual([...Event.options].sort());
    });

    it('every non-terminal, non-gate, non-READY phase has at least one outgoing transition', () => {
      const phases: Phase[] = [
        'TICKET',
        'PLAN',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'ARCHITECTURE',
        'PEER_REVIEW',
      ];
      for (const phase of phases) {
        const map = TRANSITIONS.get(phase);
        expect(map).toBeDefined();
        expect(map!.size).toBeGreaterThan(0);
      }
    });
  });

  // ─── FLOW_PHASES (canonical forward progression) ───────────
  describe('FLOW_PHASES (canonical forward progression)', () => {
    const FLOWS = ['ticket', 'architecture', 'review'] as const;

    it('GOLDEN ORDER: pins the canonical forward progression of each flow', () => {
      // Regression specification (test oracle), deliberately repeating values.
      expect(FLOW_PHASES.ticket).toEqual([
        'TICKET',
        'PLAN',
        'PLAN_REVIEW',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_VALIDATION',
        'IMPL_REVIEW',
        'EVIDENCE_REVIEW',
        'EXPORT_READY',
        'COMPLETE',
      ]);
      expect(FLOW_PHASES.architecture).toEqual(['ARCHITECTURE', 'ARCH_REVIEW', 'ARCH_COMPLETE']);
      expect(FLOW_PHASES.review).toEqual(['PEER_REVIEW', 'PEER_REVIEW_COMPLETE']);
    });

    it('ADJACENCY (one-directional): every adjacent pair has a TRANSITIONS edge', () => {
      for (const flow of FLOWS) {
        const phases = FLOW_PHASES[flow];
        for (let index = 1; index < phases.length; index++) {
          const from = phases[index - 1]!;
          const to = phases[index]!;
          const targets = new Set<Phase>(TRANSITIONS.get(from)?.values() ?? []);
          expect(targets.has(to), `${flow}: ${from} -> ${to} must have a topology edge`).toBe(true);
        }
      }
    });

    it('COVERAGE: the union partitions every normal phase exactly once', () => {
      const flowPhases = Object.values(FLOW_PHASES).flat();
      const counts = new Map<string, number>();
      for (const phase of flowPhases) {
        counts.set(phase, (counts.get(phase) ?? 0) + 1);
      }

      const duplicated = [...counts].filter(([, count]) => count > 1).map(([phase]) => phase);
      expect(duplicated).toEqual([]);

      // Routing/shared-terminal exceptions are intentionally absent from every flow.
      for (const exception of ['READY', 'REJECTED', 'ABORTED'] as Phase[]) {
        expect(counts.has(exception), `${exception} must not be in a progression`).toBe(false);
      }

      const covered = new Set<string>(flowPhases);
      const uncovered = [...TRANSITIONS.keys()].filter((phase) => !covered.has(phase)).sort();
      expect(uncovered).toEqual(['ABORTED', 'READY', 'REJECTED']);
    });

    it('ENTRY: each flow is entered from READY by its *_SELECTED event', () => {
      expect(resolveTransition('READY', 'TICKET_SELECTED')).toBe(FLOW_PHASES.ticket[0]);
      expect(resolveTransition('READY', 'ARCHITECTURE_SELECTED')).toBe(FLOW_PHASES.architecture[0]);
      expect(resolveTransition('READY', 'PEER_REVIEW_SELECTED')).toBe(FLOW_PHASES.review[0]);
    });

    it('isFlowPhaseAtOrAfter orders milestones inside a flow', () => {
      expect(isFlowPhaseAtOrAfter('ticket', 'VALIDATION', 'VALIDATION')).toBe(true);
      expect(isFlowPhaseAtOrAfter('ticket', 'IMPLEMENTATION', 'VALIDATION')).toBe(true);
      expect(isFlowPhaseAtOrAfter('ticket', 'PLAN_REVIEW', 'VALIDATION')).toBe(false);

      expect(isFlowPhaseAtOrAfter('architecture', 'ARCH_COMPLETE', 'ARCH_REVIEW')).toBe(true);
      expect(isFlowPhaseAtOrAfter('architecture', 'ARCHITECTURE', 'ARCH_COMPLETE')).toBe(false);
      expect(isFlowPhaseAtOrAfter('review', 'PEER_REVIEW', 'PEER_REVIEW_COMPLETE')).toBe(false);
    });

    it('isFlowPhaseAtOrAfter is fail-closed for phases outside the flow', () => {
      // current outside the flow (routing, shared terminal, or another flow)
      for (const current of ['READY', 'REJECTED', 'ABORTED', 'ARCH_REVIEW'] as Phase[]) {
        expect(isFlowPhaseAtOrAfter('ticket', current, 'TICKET')).toBe(false);
      }
      // required outside the flow must never be satisfied by index arithmetic
      for (const required of ['READY', 'REJECTED', 'ABORTED', 'VALIDATION'] as Phase[]) {
        expect(isFlowPhaseAtOrAfter('architecture', 'ARCHITECTURE', required)).toBe(false);
      }
    });

    it('isFlowPhase is the flow-membership authority', () => {
      expect(isFlowPhase('ticket', 'VALIDATION')).toBe(true);
      expect(isFlowPhase('architecture', 'ARCH_REVIEW')).toBe(true);
      expect(isFlowPhase('review', 'PEER_REVIEW_COMPLETE')).toBe(true);

      expect(isFlowPhase('ticket', 'ARCH_REVIEW')).toBe(false);
      expect(isFlowPhase('architecture', 'VALIDATION')).toBe(false);
      expect(isFlowPhase('review', 'PEER_REVIEW')).toBe(true);
      for (const exception of ['READY', 'REJECTED', 'ABORTED'] as Phase[]) {
        expect(isFlowPhase('ticket', exception)).toBe(false);
        expect(isFlowPhase('architecture', exception)).toBe(false);
        expect(isFlowPhase('review', exception)).toBe(false);
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
