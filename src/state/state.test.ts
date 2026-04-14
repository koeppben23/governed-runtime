import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  CheckId,
  ReviewVerdict,
  RevisionDelta,
  LoopVerdict,
  BindingInfo,
  TicketEvidence,
  PlanEvidence,
  PlanRecord,
  SelfReviewLoop,
  ValidationResult,
  ImplEvidence,
  ImplReviewResult,
  ReviewDecision,
  ErrorInfo,
  PolicySnapshotSchema,
  AuditEvent,
  ReviewReport,
} from "../state/evidence";
import { Phase, Event, Transition, SessionState } from "../state/schema";
import { makeState, FIXED_TIME, FIXED_UUID, FIXED_SESSION_UUID } from "../__fixtures__";
import { benchmarkSync, PERF_BUDGETS } from "../test-policy";

describe("state schemas", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("Phase parses all 8 valid phases", () => {
      const phases = [
        "TICKET", "PLAN", "PLAN_REVIEW", "VALIDATION",
        "IMPLEMENTATION", "IMPL_REVIEW", "EVIDENCE_REVIEW", "COMPLETE",
      ];
      for (const p of phases) {
        expect(Phase.parse(p)).toBe(p);
      }
    });

    it("Event parses all valid events", () => {
      const events = [
        "PLAN_READY", "SELF_REVIEW_MET", "SELF_REVIEW_PENDING",
        "APPROVE", "CHANGES_REQUESTED", "REJECT",
        "ALL_PASSED", "CHECK_FAILED", "IMPL_COMPLETE",
        "REVIEW_MET", "REVIEW_PENDING", "ERROR", "ABORT",
      ];
      for (const e of events) {
        expect(Event.parse(e)).toBe(e);
      }
    });

    it("TicketEvidence parses valid ticket", () => {
      const ticket = {
        text: "Fix bug",
        digest: "abc123",
        source: "user",
        createdAt: FIXED_TIME,
      };
      expect(TicketEvidence.parse(ticket)).toEqual(ticket);
    });

    it("PlanEvidence parses valid plan", () => {
      const plan = {
        body: "## Plan\nStep 1",
        digest: "abc",
        sections: ["Plan"],
        createdAt: FIXED_TIME,
      };
      expect(PlanEvidence.parse(plan)).toEqual(plan);
    });

    it("ValidationResult parses valid result", () => {
      const result = {
        checkId: "test_quality",
        passed: true,
        detail: "All pass",
        executedAt: FIXED_TIME,
      };
      expect(ValidationResult.parse(result)).toEqual(result);
    });

    it("ReviewVerdict parses all 3 verdicts", () => {
      expect(ReviewVerdict.parse("approve")).toBe("approve");
      expect(ReviewVerdict.parse("changes_requested")).toBe("changes_requested");
      expect(ReviewVerdict.parse("reject")).toBe("reject");
    });

    it("SessionState parses a full valid state", () => {
      const state = makeState("TICKET");
      expect(() => SessionState.parse(state)).not.toThrow();
    });

    it("AuditEvent parses valid event with hash chain fields", () => {
      const event = {
        id: FIXED_UUID,
        sessionId: FIXED_SESSION_UUID,
        phase: "TICKET",
        event: "lifecycle:session_created",
        timestamp: FIXED_TIME,
        actor: "system",
        detail: {},
        prevHash: "genesis",
        chainHash: "abc123",
      };
      expect(() => AuditEvent.parse(event)).not.toThrow();
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("Phase rejects unknown phase", () => {
      expect(() => Phase.parse("UNKNOWN")).toThrow();
    });

    it("Event rejects unknown event", () => {
      expect(() => Event.parse("FIRE")).toThrow();
    });

    it("TicketEvidence rejects empty text", () => {
      expect(() => TicketEvidence.parse({
        text: "",
        digest: "abc",
        source: "user",
        createdAt: FIXED_TIME,
      })).toThrow();
    });

    it("TicketEvidence rejects invalid source", () => {
      expect(() => TicketEvidence.parse({
        text: "Fix bug",
        digest: "abc",
        source: "unknown",
        createdAt: FIXED_TIME,
      })).toThrow();
    });

    it("ReviewVerdict rejects unknown verdict", () => {
      expect(() => ReviewVerdict.parse("maybe")).toThrow();
    });

    it("SelfReviewLoop rejects negative iteration", () => {
      expect(() => SelfReviewLoop.parse({
        iteration: -1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: "abc",
        revisionDelta: "none",
        verdict: "approve",
      })).toThrow();
    });

    it("SelfReviewLoop rejects zero maxIterations", () => {
      expect(() => SelfReviewLoop.parse({
        iteration: 0,
        maxIterations: 0,
        prevDigest: null,
        currDigest: "abc",
        revisionDelta: "none",
        verdict: "approve",
      })).toThrow();
    });

    it("SessionState rejects missing required fields", () => {
      expect(() => SessionState.parse({})).toThrow();
    });

    it("SessionState rejects invalid schemaVersion", () => {
      const state = { ...makeState("TICKET"), schemaVersion: "v2" };
      expect(() => SessionState.parse(state)).toThrow();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("CheckId accepts any non-empty string", () => {
      expect(CheckId.parse("test_quality")).toBe("test_quality");
      expect(CheckId.parse("custom_check_123")).toBe("custom_check_123");
    });

    it("CheckId rejects empty string", () => {
      expect(() => CheckId.parse("")).toThrow();
    });

    it("PlanRecord with empty history is valid", () => {
      const record = {
        current: {
          body: "Plan",
          digest: "abc",
          sections: [],
          createdAt: FIXED_TIME,
        },
        history: [],
      };
      expect(() => PlanRecord.parse(record)).not.toThrow();
    });

    it("PlanEvidence with empty sections array is valid", () => {
      const plan = {
        body: "No headers here",
        digest: "abc",
        sections: [],
        createdAt: FIXED_TIME,
      };
      expect(() => PlanEvidence.parse(plan)).not.toThrow();
    });

    it("AuditEvent hash chain fields are optional (legacy compat)", () => {
      const event = {
        id: FIXED_UUID,
        sessionId: FIXED_SESSION_UUID,
        phase: "TICKET",
        event: "lifecycle:session_created",
        timestamp: FIXED_TIME,
        actor: "system",
        detail: {},
      };
      expect(() => AuditEvent.parse(event)).not.toThrow();
    });

    it("validation array can be empty", () => {
      const state = makeState("TICKET");
      expect(state.validation).toEqual([]);
      expect(() => SessionState.parse(state)).not.toThrow();
    });

    it("nullable evidence fields accept null", () => {
      const state = makeState("TICKET");
      expect(state.ticket).toBeNull();
      expect(state.plan).toBeNull();
      expect(state.selfReview).toBeNull();
      expect(state.implementation).toBeNull();
      expect(state.implReview).toBeNull();
      expect(state.reviewDecision).toBeNull();
      expect(state.error).toBeNull();
      expect(state.transition).toBeNull();
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe("EDGE", () => {
    it("RevisionDelta has exactly 3 values", () => {
      expect(RevisionDelta.options).toEqual(["none", "minor", "major"]);
    });

    it("LoopVerdict has exactly 2 values (no reject)", () => {
      expect(LoopVerdict.options).toEqual(["approve", "changes_requested"]);
    });

    it("PolicySnapshotSchema validates nested audit object", () => {
      const snapshot = {
        mode: "team",
        hash: "abc",
        resolvedAt: FIXED_TIME,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: {
          emitTransitions: true,
          emitToolCalls: true,
          enableChainHash: true,
        },
      };
      expect(() => PolicySnapshotSchema.parse(snapshot)).not.toThrow();
    });

    it("ReviewReport validates overall status enum", () => {
      expect(() => ReviewReport.parse({
        schemaVersion: "flowguard-review-report.v1",
        sessionId: FIXED_UUID,
        generatedAt: FIXED_TIME,
        phase: "COMPLETE",
        planDigest: null,
        implDigest: null,
        validationSummary: [],
        findings: [],
        overallStatus: "clean",
      })).not.toThrow();
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("SessionState serialize + parse roundtrip < 5ms (p99)", () => {
      const state = makeState("TICKET");
      const result = benchmarkSync(() => {
        const json = JSON.stringify(state);
        SessionState.parse(JSON.parse(json));
      }, 200, 50);
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.stateSerializeMs);
    });
  });
});
