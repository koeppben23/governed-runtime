import { describe, it, expect } from "vitest";
import { evaluate, evaluateWithEvent } from "../machine/evaluate";
import type { EvalResult } from "../machine/evaluate";
import {
  makeState,
  makeProgressedState,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  SELF_REVIEW_PENDING as SELF_REVIEW_PENDING_FIX,
  VALIDATION_PASSED,
  VALIDATION_FAILED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
  ERROR_INFO,
  ARCHITECTURE_DECISION,
} from "../__fixtures__";
import { benchmarkSync, PERF_BUDGETS } from "../test-policy";

describe("evaluate", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("COMPLETE → terminal", () => {
      const result = evaluate(makeProgressedState("COMPLETE"));
      expect(result.kind).toBe("terminal");
    });

    it("ARCH_COMPLETE → terminal", () => {
      const result = evaluate(makeProgressedState("ARCH_COMPLETE"));
      expect(result.kind).toBe("terminal");
    });

    it("REVIEW_COMPLETE → terminal", () => {
      const result = evaluate(makeProgressedState("REVIEW_COMPLETE"));
      expect(result.kind).toBe("terminal");
    });

    it("READY → pending (command-driven)", () => {
      const result = evaluate(makeProgressedState("READY"));
      expect(result.kind).toBe("pending");
      if (result.kind === "pending") {
        expect(result.phase).toBe("READY");
      }
    });

    it("PLAN_REVIEW → waiting (default policy)", () => {
      const result = evaluate(makeProgressedState("PLAN_REVIEW"));
      expect(result.kind).toBe("waiting");
      if (result.kind === "waiting") {
        expect(result.phase).toBe("PLAN_REVIEW");
      }
    });

    it("EVIDENCE_REVIEW → waiting (default policy)", () => {
      const result = evaluate(makeProgressedState("EVIDENCE_REVIEW"));
      expect(result.kind).toBe("waiting");
    });

    it("ARCH_REVIEW → waiting (default policy)", () => {
      const result = evaluate(makeProgressedState("ARCH_REVIEW"));
      expect(result.kind).toBe("waiting");
      if (result.kind === "waiting") {
        expect(result.phase).toBe("ARCH_REVIEW");
        expect(result.reason).toContain("architecture");
      }
    });

    it("TICKET with ticket+plan → transition PLAN_READY", () => {
      const state = makeState("TICKET", { ticket: TICKET, plan: PLAN_RECORD });
      const result = evaluate(state);
      expect(result.kind).toBe("transition");
      if (result.kind === "transition") {
        expect(result.event).toBe("PLAN_READY");
        expect(result.target).toBe("PLAN");
      }
    });

    it("PLAN with converged self-review → transition SELF_REVIEW_MET", () => {
      const state = makeState("PLAN", {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_CONVERGED,
      });
      const result = evaluate(state);
      expect(result.kind).toBe("transition");
      if (result.kind === "transition") {
        expect(result.event).toBe("SELF_REVIEW_MET");
        expect(result.target).toBe("PLAN_REVIEW");
      }
    });

    it("ARCHITECTURE with converged self-review → transition SELF_REVIEW_MET → ARCH_REVIEW", () => {
      const state = makeState("ARCHITECTURE", {
        architecture: ARCHITECTURE_DECISION,
        selfReview: SELF_REVIEW_CONVERGED,
      });
      const result = evaluate(state);
      expect(result.kind).toBe("transition");
      if (result.kind === "transition") {
        expect(result.event).toBe("SELF_REVIEW_MET");
        expect(result.target).toBe("ARCH_REVIEW");
      }
    });

    it("VALIDATION with all passed → transition ALL_PASSED", () => {
      const state = makeState("VALIDATION", { validation: VALIDATION_PASSED });
      const result = evaluate(state);
      expect(result.kind).toBe("transition");
      if (result.kind === "transition") {
        expect(result.event).toBe("ALL_PASSED");
        expect(result.target).toBe("IMPLEMENTATION");
      }
    });

    it("VALIDATION with failures → transition CHECK_FAILED", () => {
      const state = makeState("VALIDATION", { validation: VALIDATION_FAILED });
      const result = evaluate(state);
      expect(result.kind).toBe("transition");
      if (result.kind === "transition") {
        expect(result.event).toBe("CHECK_FAILED");
        expect(result.target).toBe("PLAN");
      }
    });

    it("IMPLEMENTATION with impl → transition IMPL_COMPLETE", () => {
      const state = makeState("IMPLEMENTATION", { implementation: IMPL_EVIDENCE });
      const result = evaluate(state);
      expect(result.kind).toBe("transition");
      if (result.kind === "transition") {
        expect(result.event).toBe("IMPL_COMPLETE");
        expect(result.target).toBe("IMPL_REVIEW");
      }
    });

    it("REVIEW → transition REVIEW_DONE → REVIEW_COMPLETE", () => {
      const state = makeState("REVIEW");
      const result = evaluate(state);
      expect(result.kind).toBe("transition");
      if (result.kind === "transition") {
        expect(result.event).toBe("REVIEW_DONE");
        expect(result.target).toBe("REVIEW_COMPLETE");
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("TICKET without evidence → pending", () => {
      const result = evaluate(makeState("TICKET"));
      expect(result.kind).toBe("pending");
    });

    it("PLAN without selfReview → pending", () => {
      const result = evaluate(makeState("PLAN", { ticket: TICKET, plan: PLAN_RECORD }));
      expect(result.kind).toBe("pending");
    });

    it("IMPLEMENTATION without impl → pending", () => {
      const result = evaluate(makeState("IMPLEMENTATION"));
      expect(result.kind).toBe("pending");
    });

    it("VALIDATION without results → pending", () => {
      const result = evaluate(makeState("VALIDATION"));
      expect(result.kind).toBe("pending");
    });

    it("ARCHITECTURE without selfReview → pending", () => {
      const result = evaluate(makeState("ARCHITECTURE", { architecture: ARCHITECTURE_DECISION }));
      expect(result.kind).toBe("pending");
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("solo mode: user gates auto-approve via APPROVE event", () => {
      const soloPolicy = { requireHumanGates: false };

      const planReview = evaluate(makeProgressedState("PLAN_REVIEW"), soloPolicy);
      expect(planReview.kind).toBe("transition");
      if (planReview.kind === "transition") {
        expect(planReview.event).toBe("APPROVE");
        expect(planReview.target).toBe("VALIDATION");
      }

      const evidenceReview = evaluate(makeProgressedState("EVIDENCE_REVIEW"), soloPolicy);
      expect(evidenceReview.kind).toBe("transition");
      if (evidenceReview.kind === "transition") {
        expect(evidenceReview.event).toBe("APPROVE");
        expect(evidenceReview.target).toBe("COMPLETE");
      }

      const archReview = evaluate(makeProgressedState("ARCH_REVIEW"), soloPolicy);
      expect(archReview.kind).toBe("transition");
      if (archReview.kind === "transition") {
        expect(archReview.event).toBe("APPROVE");
        expect(archReview.target).toBe("ARCH_COMPLETE");
      }
    });

    it("ERROR takes priority over all other guards (fail-closed)", () => {
      // State has both error AND valid evidence
      const state = makeState("TICKET", {
        ticket: TICKET,
        plan: PLAN_RECORD,
        error: ERROR_INFO,
      });
      const result = evaluate(state);
      expect(result.kind).toBe("transition");
      if (result.kind === "transition") {
        expect(result.event).toBe("ERROR");
        expect(result.target).toBe("TICKET"); // ERROR loops back
      }
    });

    it("PLAN self-review pending → transition SELF_REVIEW_PENDING (self-loop)", () => {
      const state = makeState("PLAN", {
        ticket: TICKET,
        plan: PLAN_RECORD,
        selfReview: SELF_REVIEW_PENDING_FIX,
      });
      const result = evaluate(state);
      expect(result.kind).toBe("transition");
      if (result.kind === "transition") {
        expect(result.event).toBe("SELF_REVIEW_PENDING");
        expect(result.target).toBe("PLAN"); // self-loop
      }
    });

    it("READY returns pending regardless of policy", () => {
      const soloPolicy = { requireHumanGates: false };
      const result = evaluate(makeState("READY"), soloPolicy);
      expect(result.kind).toBe("pending");
      if (result.kind === "pending") {
        expect(result.phase).toBe("READY");
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe("EDGE", () => {
    it("no policy → defaults to requiring human gates", () => {
      const result = evaluate(makeProgressedState("PLAN_REVIEW"));
      expect(result.kind).toBe("waiting");
    });

    it("policy with requireHumanGates: true → waiting at gates", () => {
      const result = evaluate(
        makeProgressedState("PLAN_REVIEW"),
        { requireHumanGates: true },
      );
      expect(result.kind).toBe("waiting");
    });

    it("evaluateWithEvent resolves known phase+event combos", () => {
      expect(evaluateWithEvent("PLAN_REVIEW", "APPROVE")).toBe("VALIDATION");
      expect(evaluateWithEvent("PLAN_REVIEW", "CHANGES_REQUESTED")).toBe("PLAN");
      expect(evaluateWithEvent("PLAN_REVIEW", "REJECT")).toBe("TICKET");
      expect(evaluateWithEvent("ARCH_REVIEW", "APPROVE")).toBe("ARCH_COMPLETE");
      expect(evaluateWithEvent("ARCH_REVIEW", "CHANGES_REQUESTED")).toBe("ARCHITECTURE");
      expect(evaluateWithEvent("ARCH_REVIEW", "REJECT")).toBe("READY");
    });

    it("evaluateWithEvent returns undefined for invalid combo", () => {
      expect(evaluateWithEvent("TICKET", "APPROVE")).toBeUndefined();
      expect(evaluateWithEvent("READY", "APPROVE")).toBeUndefined();
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("evaluate() < 1ms (p99)", () => {
      const state = makeState("VALIDATION", { validation: VALIDATION_PASSED });
      const result = benchmarkSync(() => {
        evaluate(state);
      }, 200, 50);
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.evaluateSingleMs);
    });
  });
});
