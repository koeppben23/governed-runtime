import { describe, it, expect } from "vitest";
import { TRANSITIONS, USER_GATES, TERMINAL, resolveTransition } from "../machine/topology";
import type { Phase, Event } from "../state/schema";
import { benchmarkSync, PERF_BUDGETS } from "../test-policy";

describe("topology", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("resolves TICKET + PLAN_READY → PLAN", () => {
      expect(resolveTransition("TICKET", "PLAN_READY")).toBe("PLAN");
    });

    it("resolves PLAN + SELF_REVIEW_MET → PLAN_REVIEW", () => {
      expect(resolveTransition("PLAN", "SELF_REVIEW_MET")).toBe("PLAN_REVIEW");
    });

    it("resolves PLAN_REVIEW + APPROVE → VALIDATION", () => {
      expect(resolveTransition("PLAN_REVIEW", "APPROVE")).toBe("VALIDATION");
    });

    it("resolves VALIDATION + ALL_PASSED → IMPLEMENTATION", () => {
      expect(resolveTransition("VALIDATION", "ALL_PASSED")).toBe("IMPLEMENTATION");
    });

    it("resolves IMPLEMENTATION + IMPL_COMPLETE → IMPL_REVIEW", () => {
      expect(resolveTransition("IMPLEMENTATION", "IMPL_COMPLETE")).toBe("IMPL_REVIEW");
    });

    it("resolves IMPL_REVIEW + REVIEW_MET → EVIDENCE_REVIEW", () => {
      expect(resolveTransition("IMPL_REVIEW", "REVIEW_MET")).toBe("EVIDENCE_REVIEW");
    });

    it("resolves EVIDENCE_REVIEW + APPROVE → COMPLETE", () => {
      expect(resolveTransition("EVIDENCE_REVIEW", "APPROVE")).toBe("COMPLETE");
    });

    it("resolves all backward transitions", () => {
      expect(resolveTransition("PLAN_REVIEW", "CHANGES_REQUESTED")).toBe("PLAN");
      expect(resolveTransition("PLAN_REVIEW", "REJECT")).toBe("TICKET");
      expect(resolveTransition("EVIDENCE_REVIEW", "CHANGES_REQUESTED")).toBe("IMPLEMENTATION");
      expect(resolveTransition("EVIDENCE_REVIEW", "REJECT")).toBe("TICKET");
      expect(resolveTransition("VALIDATION", "CHECK_FAILED")).toBe("PLAN");
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("returns undefined for invalid phase+event combo", () => {
      expect(resolveTransition("TICKET", "APPROVE")).toBeUndefined();
      expect(resolveTransition("PLAN", "APPROVE")).toBeUndefined();
      expect(resolveTransition("IMPLEMENTATION", "ALL_PASSED")).toBeUndefined();
    });

    it("returns undefined for all events at COMPLETE", () => {
      const events: Event[] = [
        "PLAN_READY", "SELF_REVIEW_MET", "SELF_REVIEW_PENDING",
        "APPROVE", "CHANGES_REQUESTED", "REJECT",
        "ALL_PASSED", "CHECK_FAILED", "IMPL_COMPLETE",
        "REVIEW_MET", "REVIEW_PENDING", "ERROR", "ABORT",
      ];
      for (const event of events) {
        expect(resolveTransition("COMPLETE", event)).toBeUndefined();
      }
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("ERROR loops back to same phase for non-gate, non-terminal phases", () => {
      const phasesWithError: Phase[] = ["TICKET", "PLAN", "VALIDATION", "IMPLEMENTATION", "IMPL_REVIEW"];
      for (const phase of phasesWithError) {
        expect(resolveTransition(phase, "ERROR")).toBe(phase);
      }
    });

    it("user gates have no ERROR event", () => {
      expect(resolveTransition("PLAN_REVIEW", "ERROR")).toBeUndefined();
      expect(resolveTransition("EVIDENCE_REVIEW", "ERROR")).toBeUndefined();
    });

    it("COMPLETE has empty transition map", () => {
      const completeMap = TRANSITIONS.get("COMPLETE");
      expect(completeMap).toBeDefined();
      expect(completeMap!.size).toBe(0);
    });

    it("transition table covers all 8 phases", () => {
      const phases: Phase[] = [
        "TICKET", "PLAN", "PLAN_REVIEW", "VALIDATION",
        "IMPLEMENTATION", "IMPL_REVIEW", "EVIDENCE_REVIEW", "COMPLETE",
      ];
      for (const phase of phases) {
        expect(TRANSITIONS.has(phase)).toBe(true);
      }
      expect(TRANSITIONS.size).toBe(8);
    });

    it("self-loop: PLAN + SELF_REVIEW_PENDING → PLAN", () => {
      expect(resolveTransition("PLAN", "SELF_REVIEW_PENDING")).toBe("PLAN");
    });

    it("self-loop: IMPL_REVIEW + REVIEW_PENDING → IMPL_REVIEW", () => {
      expect(resolveTransition("IMPL_REVIEW", "REVIEW_PENDING")).toBe("IMPL_REVIEW");
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe("EDGE", () => {
    it("USER_GATES contains exactly PLAN_REVIEW and EVIDENCE_REVIEW", () => {
      expect(USER_GATES.size).toBe(2);
      expect(USER_GATES.has("PLAN_REVIEW")).toBe(true);
      expect(USER_GATES.has("EVIDENCE_REVIEW")).toBe(true);
    });

    it("TERMINAL contains exactly COMPLETE", () => {
      expect(TERMINAL.size).toBe(1);
      expect(TERMINAL.has("COMPLETE")).toBe(true);
    });

    it("no phase appears as both a user gate and terminal", () => {
      for (const phase of USER_GATES) {
        expect(TERMINAL.has(phase)).toBe(false);
      }
    });

    it("every non-terminal, non-gate phase has at least one outgoing transition", () => {
      const phases: Phase[] = ["TICKET", "PLAN", "VALIDATION", "IMPLEMENTATION", "IMPL_REVIEW"];
      for (const phase of phases) {
        const map = TRANSITIONS.get(phase);
        expect(map).toBeDefined();
        expect(map!.size).toBeGreaterThan(0);
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it(`transition lookup < ${PERF_BUDGETS.guardPredicateMs}ms (p99)`, () => {
      const result = benchmarkSync(() => {
        resolveTransition("VALIDATION", "ALL_PASSED");
      });
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.guardPredicateMs);
    });
  });
});
