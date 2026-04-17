import { describe, it, expect } from 'vitest';
import { Command, isCommandAllowed } from '../machine/commands';
import type { Phase } from '../state/schema';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy';

describe('commands', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('/ticket is allowed in READY and TICKET', () => {
      expect(isCommandAllowed('READY', Command.TICKET)).toBe(true);
      expect(isCommandAllowed('TICKET', Command.TICKET)).toBe(true);
    });

    it('/plan is allowed in READY, TICKET, and PLAN', () => {
      expect(isCommandAllowed('READY', Command.PLAN)).toBe(true);
      expect(isCommandAllowed('TICKET', Command.PLAN)).toBe(true);
      expect(isCommandAllowed('PLAN', Command.PLAN)).toBe(true);
    });

    it('/architecture is allowed in READY', () => {
      expect(isCommandAllowed('READY', Command.ARCHITECTURE)).toBe(true);
    });

    it('/review is allowed in READY', () => {
      expect(isCommandAllowed('READY', Command.REVIEW)).toBe(true);
    });

    it('/implement is allowed in IMPLEMENTATION', () => {
      expect(isCommandAllowed('IMPLEMENTATION', Command.IMPLEMENT)).toBe(true);
    });

    it('/review-decision is allowed at all user gates', () => {
      expect(isCommandAllowed('PLAN_REVIEW', Command.REVIEW_DECISION)).toBe(true);
      expect(isCommandAllowed('EVIDENCE_REVIEW', Command.REVIEW_DECISION)).toBe(true);
      expect(isCommandAllowed('ARCH_REVIEW', Command.REVIEW_DECISION)).toBe(true);
    });

    it('/validate is allowed in VALIDATION', () => {
      expect(isCommandAllowed('VALIDATION', Command.VALIDATE)).toBe(true);
    });

    it('wildcard commands allowed in all non-terminal phases', () => {
      const phases: Phase[] = [
        'READY',
        'TICKET',
        'PLAN',
        'PLAN_REVIEW',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'EVIDENCE_REVIEW',
        'ARCHITECTURE',
        'ARCH_REVIEW',
        'REVIEW',
      ];
      for (const phase of phases) {
        expect(isCommandAllowed(phase, Command.HYDRATE)).toBe(true);
        expect(isCommandAllowed(phase, Command.CONTINUE)).toBe(true);
        expect(isCommandAllowed(phase, Command.ABORT)).toBe(true);
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('/ticket blocked outside READY and TICKET', () => {
      const blockedPhases: Phase[] = [
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
      for (const phase of blockedPhases) {
        expect(isCommandAllowed(phase, Command.TICKET)).toBe(false);
      }
    });

    it('/architecture blocked outside READY and ARCHITECTURE', () => {
      const blockedPhases: Phase[] = [
        'TICKET',
        'PLAN',
        'PLAN_REVIEW',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'EVIDENCE_REVIEW',
        'COMPLETE',
        'ARCH_REVIEW',
        'ARCH_COMPLETE',
        'REVIEW',
        'REVIEW_COMPLETE',
      ];
      for (const phase of blockedPhases) {
        expect(isCommandAllowed(phase, Command.ARCHITECTURE)).toBe(false);
      }
      expect(isCommandAllowed('ARCHITECTURE', Command.ARCHITECTURE)).toBe(true);
    });

    it('/review blocked outside READY', () => {
      const blockedPhases: Phase[] = [
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
      for (const phase of blockedPhases) {
        expect(isCommandAllowed(phase, Command.REVIEW)).toBe(false);
      }
    });

    it('/implement blocked outside IMPLEMENTATION', () => {
      expect(isCommandAllowed('TICKET', Command.IMPLEMENT)).toBe(false);
      expect(isCommandAllowed('PLAN', Command.IMPLEMENT)).toBe(false);
      expect(isCommandAllowed('COMPLETE', Command.IMPLEMENT)).toBe(false);
    });

    it('/review-decision blocked outside user gates', () => {
      expect(isCommandAllowed('TICKET', Command.REVIEW_DECISION)).toBe(false);
      expect(isCommandAllowed('PLAN', Command.REVIEW_DECISION)).toBe(false);
      expect(isCommandAllowed('IMPLEMENTATION', Command.REVIEW_DECISION)).toBe(false);
      expect(isCommandAllowed('READY', Command.REVIEW_DECISION)).toBe(false);
    });

    it('/validate blocked outside VALIDATION', () => {
      expect(isCommandAllowed('TICKET', Command.VALIDATE)).toBe(false);
      expect(isCommandAllowed('PLAN', Command.VALIDATE)).toBe(false);
      expect(isCommandAllowed('READY', Command.VALIDATE)).toBe(false);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('all terminal phases block ALL mutating commands', () => {
      const terminals: Phase[] = ['COMPLETE', 'ARCH_COMPLETE', 'REVIEW_COMPLETE'];
      const mutatingCommands: Command[] = [
        Command.HYDRATE,
        Command.TICKET,
        Command.PLAN,
        Command.CONTINUE,
        Command.IMPLEMENT,
        Command.REVIEW_DECISION,
        Command.VALIDATE,
        Command.REVIEW,
        Command.ARCHITECTURE,
        Command.ABORT,
      ];
      for (const phase of terminals) {
        for (const cmd of mutatingCommands) {
          expect(isCommandAllowed(phase, cmd)).toBe(false);
        }
      }
    });

    it('no commands allowed at terminal phases (all are mutating)', () => {
      // All commands are mutating, so terminals block everything
      expect(isCommandAllowed('COMPLETE', Command.HYDRATE)).toBe(false);
      expect(isCommandAllowed('ARCH_COMPLETE', Command.HYDRATE)).toBe(false);
      expect(isCommandAllowed('REVIEW_COMPLETE', Command.HYDRATE)).toBe(false);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('unknown command returns false (fail-closed)', () => {
      expect(isCommandAllowed('TICKET', 'unknown' as Command)).toBe(false);
    });

    it('Command enum has exactly 10 entries', () => {
      expect(Object.keys(Command).length).toBe(10);
    });

    it('/plan is allowed in READY, TICKET, and PLAN (direct plan from any start)', () => {
      expect(isCommandAllowed('READY', Command.PLAN)).toBe(true);
      expect(isCommandAllowed('TICKET', Command.PLAN)).toBe(true);
      expect(isCommandAllowed('PLAN', Command.PLAN)).toBe(true);
    });

    it('READY allows exactly the 3 flow commands + wildcards', () => {
      // Flow commands
      expect(isCommandAllowed('READY', Command.TICKET)).toBe(true);
      expect(isCommandAllowed('READY', Command.ARCHITECTURE)).toBe(true);
      expect(isCommandAllowed('READY', Command.REVIEW)).toBe(true);
      expect(isCommandAllowed('READY', Command.PLAN)).toBe(true);
      // Wildcards
      expect(isCommandAllowed('READY', Command.HYDRATE)).toBe(true);
      expect(isCommandAllowed('READY', Command.CONTINUE)).toBe(true);
      expect(isCommandAllowed('READY', Command.ABORT)).toBe(true);
      // Blocked
      expect(isCommandAllowed('READY', Command.IMPLEMENT)).toBe(false);
      expect(isCommandAllowed('READY', Command.REVIEW_DECISION)).toBe(false);
      expect(isCommandAllowed('READY', Command.VALIDATE)).toBe(false);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it(`isCommandAllowed < ${PERF_BUDGETS.guardPredicateMs}ms (p99)`, () => {
      const result = benchmarkSync(() => {
        isCommandAllowed('VALIDATION', Command.VALIDATE);
      });
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.guardPredicateMs);
    });
  });
});
