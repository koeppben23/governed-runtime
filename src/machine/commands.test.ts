import { describe, it, expect } from "vitest";
import { Command, isCommandAllowed } from "../machine/commands";
import type { Phase } from "../state/schema";
import { benchmarkSync, PERF_BUDGETS } from "../test-policy";

describe("commands", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("/ticket is allowed in TICKET", () => {
      expect(isCommandAllowed("TICKET", Command.TICKET)).toBe(true);
    });

    it("/plan is allowed in TICKET and PLAN", () => {
      expect(isCommandAllowed("TICKET", Command.PLAN)).toBe(true);
      expect(isCommandAllowed("PLAN", Command.PLAN)).toBe(true);
    });

    it("/implement is allowed in IMPLEMENTATION", () => {
      expect(isCommandAllowed("IMPLEMENTATION", Command.IMPLEMENT)).toBe(true);
    });

    it("/review-decision is allowed at user gates", () => {
      expect(isCommandAllowed("PLAN_REVIEW", Command.REVIEW_DECISION)).toBe(true);
      expect(isCommandAllowed("EVIDENCE_REVIEW", Command.REVIEW_DECISION)).toBe(true);
    });

    it("/validate is allowed in VALIDATION", () => {
      expect(isCommandAllowed("VALIDATION", Command.VALIDATE)).toBe(true);
    });

    it("wildcard commands allowed in all non-COMPLETE phases", () => {
      const phases: Phase[] = [
        "TICKET", "PLAN", "PLAN_REVIEW", "VALIDATION",
        "IMPLEMENTATION", "IMPL_REVIEW", "EVIDENCE_REVIEW",
      ];
      for (const phase of phases) {
        expect(isCommandAllowed(phase, Command.HYDRATE)).toBe(true);
        expect(isCommandAllowed(phase, Command.CONTINUE)).toBe(true);
        expect(isCommandAllowed(phase, Command.REVIEW)).toBe(true);
        expect(isCommandAllowed(phase, Command.ABORT)).toBe(true);
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("/ticket blocked outside TICKET phase", () => {
      const otherPhases: Phase[] = [
        "PLAN", "PLAN_REVIEW", "VALIDATION",
        "IMPLEMENTATION", "IMPL_REVIEW", "EVIDENCE_REVIEW", "COMPLETE",
      ];
      for (const phase of otherPhases) {
        expect(isCommandAllowed(phase, Command.TICKET)).toBe(false);
      }
    });

    it("/implement blocked outside IMPLEMENTATION", () => {
      expect(isCommandAllowed("TICKET", Command.IMPLEMENT)).toBe(false);
      expect(isCommandAllowed("PLAN", Command.IMPLEMENT)).toBe(false);
      expect(isCommandAllowed("COMPLETE", Command.IMPLEMENT)).toBe(false);
    });

    it("/review-decision blocked outside user gates", () => {
      expect(isCommandAllowed("TICKET", Command.REVIEW_DECISION)).toBe(false);
      expect(isCommandAllowed("PLAN", Command.REVIEW_DECISION)).toBe(false);
      expect(isCommandAllowed("IMPLEMENTATION", Command.REVIEW_DECISION)).toBe(false);
    });

    it("/validate blocked outside VALIDATION", () => {
      expect(isCommandAllowed("TICKET", Command.VALIDATE)).toBe(false);
      expect(isCommandAllowed("PLAN", Command.VALIDATE)).toBe(false);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("COMPLETE blocks ALL mutating commands", () => {
      expect(isCommandAllowed("COMPLETE", Command.HYDRATE)).toBe(false);
      expect(isCommandAllowed("COMPLETE", Command.TICKET)).toBe(false);
      expect(isCommandAllowed("COMPLETE", Command.PLAN)).toBe(false);
      expect(isCommandAllowed("COMPLETE", Command.CONTINUE)).toBe(false);
      expect(isCommandAllowed("COMPLETE", Command.IMPLEMENT)).toBe(false);
      expect(isCommandAllowed("COMPLETE", Command.REVIEW_DECISION)).toBe(false);
      expect(isCommandAllowed("COMPLETE", Command.VALIDATE)).toBe(false);
      expect(isCommandAllowed("COMPLETE", Command.ABORT)).toBe(false);
    });

    it("/review is the ONLY command allowed at COMPLETE", () => {
      expect(isCommandAllowed("COMPLETE", Command.REVIEW)).toBe(true);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe("EDGE", () => {
    it("unknown command returns false (fail-closed)", () => {
      // Force an unknown command string
      expect(isCommandAllowed("TICKET", "unknown" as Command)).toBe(false);
    });

    it("Command enum has exactly 9 entries", () => {
      expect(Object.keys(Command).length).toBe(9);
    });

    it("/plan is allowed in both TICKET and PLAN (re-planning)", () => {
      expect(isCommandAllowed("TICKET", Command.PLAN)).toBe(true);
      expect(isCommandAllowed("PLAN", Command.PLAN)).toBe(true);
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it(`isCommandAllowed < ${PERF_BUDGETS.guardPredicateMs}ms (p99)`, () => {
      const result = benchmarkSync(() => {
        isCommandAllowed("VALIDATION", Command.VALIDATE);
      });
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.guardPredicateMs);
    });
  });
});
