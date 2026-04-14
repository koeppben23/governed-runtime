import { describe, it, expect } from "vitest";
import { executeHydrate } from "../rails/hydrate";
import { executeTicket } from "../rails/ticket";
import { executeReviewDecision } from "../rails/review-decision";
import { executeAbort } from "../rails/abort";
import { createTestContext } from "../testing";
import {
  makeState,
  makeProgressedState,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  VALIDATION_PASSED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
  REVIEW_APPROVE,
  FIXED_SESSION_UUID,
} from "../__fixtures__";
import { REGULATED_POLICY, TEAM_POLICY } from "../config/policy";

const ctx = createTestContext();

describe("hydrate rail", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("creates new session when existingState is null", () => {
      const result = executeHydrate(null, {
        sessionId: FIXED_SESSION_UUID,
        worktree: "/tmp/test",
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.phase).toBe("TICKET");
        expect(result.state.binding.sessionId).toBe(FIXED_SESSION_UUID);
        expect(result.state.binding.worktree).toBe("/tmp/test");
        expect(result.state.schemaVersion).toBe("v1");
        expect(result.transitions.length).toBe(0);
      }
    });

    it("returns existing state unchanged (idempotent)", () => {
      const existing = makeState("PLAN");
      const result = executeHydrate(existing, {
        sessionId: FIXED_SESSION_UUID,
        worktree: "/tmp/test",
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state).toBe(existing);
      }
    });

    it("resolves policy mode", () => {
      const result = executeHydrate(null, {
        sessionId: FIXED_SESSION_UUID,
        worktree: "/tmp/test",
        policyMode: "regulated",
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.policySnapshot.mode).toBe("regulated");
      }
    });

    it("sets initiatedBy from input", () => {
      const result = executeHydrate(null, {
        sessionId: FIXED_SESSION_UUID,
        worktree: "/tmp/test",
        initiatedBy: "alice",
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.initiatedBy).toBe("alice");
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("blocks on empty sessionId", () => {
      const result = executeHydrate(null, { sessionId: "", worktree: "/tmp" }, ctx);
      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") {
        expect(result.code).toBe("MISSING_SESSION_ID");
      }
    });

    it("blocks on empty worktree", () => {
      const result = executeHydrate(null, { sessionId: FIXED_SESSION_UUID, worktree: "" }, ctx);
      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") {
        expect(result.code).toBe("MISSING_WORKTREE");
      }
    });

    it("blocks on whitespace-only sessionId", () => {
      const result = executeHydrate(null, { sessionId: "   ", worktree: "/tmp" }, ctx);
      expect(result.kind).toBe("blocked");
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("defaults policyMode to team", () => {
      const result = executeHydrate(null, {
        sessionId: FIXED_SESSION_UUID,
        worktree: "/tmp/test",
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.policySnapshot.mode).toBe("team");
      }
    });

    it("defaults initiatedBy to sessionId", () => {
      const result = executeHydrate(null, {
        sessionId: FIXED_SESSION_UUID,
        worktree: "/tmp/test",
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.initiatedBy).toBe(FIXED_SESSION_UUID);
      }
    });

    it("resolves profile from repoSignals", () => {
      const result = executeHydrate(null, {
        sessionId: FIXED_SESSION_UUID,
        worktree: "/tmp/test",
        repoSignals: { files: [], packageFiles: ["pom.xml"], configFiles: [] },
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.activeProfile?.id).toBe("backend-java");
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe("EDGE", () => {
    it("explicit profileId takes precedence over repoSignals", () => {
      const result = executeHydrate(null, {
        sessionId: FIXED_SESSION_UUID,
        worktree: "/tmp/test",
        profileId: "typescript",
        repoSignals: { files: [], packageFiles: ["pom.xml"], configFiles: [] },
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.activeProfile?.id).toBe("typescript");
      }
    });

    it("custom activeChecks override profile defaults", () => {
      const result = executeHydrate(null, {
        sessionId: FIXED_SESSION_UUID,
        worktree: "/tmp/test",
        activeChecks: ["custom_check"],
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.activeChecks).toEqual(["custom_check"]);
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("hydrate is fast (smoke test)", () => {
      const start = performance.now();
      executeHydrate(null, { sessionId: FIXED_SESSION_UUID, worktree: "/tmp" }, ctx);
      expect(performance.now() - start).toBeLessThan(50);
    });
  });
});

describe("ticket rail", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("records ticket evidence in TICKET phase", () => {
      const state = makeState("TICKET");
      const result = executeTicket(state, { text: "Fix auth bug", source: "user" }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.ticket).not.toBeNull();
        expect(result.state.ticket!.text).toBe("Fix auth bug");
        expect(result.state.ticket!.source).toBe("user");
        expect(result.state.ticket!.digest).toBeDefined();
      }
    });

    it("clears downstream evidence on re-ticketing", () => {
      const state = makeState("TICKET", { plan: PLAN_RECORD, selfReview: SELF_REVIEW_CONVERGED });
      const result = executeTicket(state, { text: "New task", source: "user" }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.plan).toBeNull();
        expect(result.state.selfReview).toBeNull();
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("blocks on empty text", () => {
      const result = executeTicket(makeState("TICKET"), { text: "", source: "user" }, ctx);
      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") expect(result.code).toBe("EMPTY_TICKET");
    });

    it("blocks on whitespace-only text", () => {
      const result = executeTicket(makeState("TICKET"), { text: "   ", source: "user" }, ctx);
      expect(result.kind).toBe("blocked");
    });

    it("blocks in wrong phase", () => {
      const result = executeTicket(makeState("PLAN"), { text: "task", source: "user" }, ctx);
      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") expect(result.code).toBe("COMMAND_NOT_ALLOWED");
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("blocks at COMPLETE", () => {
      const result = executeTicket(makeProgressedState("COMPLETE"), { text: "task", source: "user" }, ctx);
      expect(result.kind).toBe("blocked");
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe("EDGE", () => {
    it("source can be external", () => {
      const result = executeTicket(makeState("TICKET"), { text: "task", source: "external" }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(result.state.ticket!.source).toBe("external");
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("ticket execution is fast (smoke test)", () => {
      const start = performance.now();
      executeTicket(makeState("TICKET"), { text: "task", source: "user" }, ctx);
      expect(performance.now() - start).toBeLessThan(50);
    });
  });
});

describe("review-decision rail", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("approve at PLAN_REVIEW → VALIDATION", () => {
      const state = makeProgressedState("PLAN_REVIEW");
      const result = executeReviewDecision(state, {
        verdict: "approve",
        rationale: "LGTM",
        decidedBy: "reviewer-1",
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.phase).toBe("VALIDATION");
        expect(result.state.reviewDecision?.verdict).toBe("approve");
      }
    });

    it("approve at EVIDENCE_REVIEW → COMPLETE", () => {
      const state = makeProgressedState("EVIDENCE_REVIEW");
      const result = executeReviewDecision(state, {
        verdict: "approve",
        rationale: "Ship it",
        decidedBy: "reviewer-1",
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.phase).toBe("COMPLETE");
      }
    });

    it("changes_requested at PLAN_REVIEW → PLAN", () => {
      const state = makeProgressedState("PLAN_REVIEW");
      const result = executeReviewDecision(state, {
        verdict: "changes_requested",
        rationale: "Needs more detail",
        decidedBy: "reviewer-1",
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.phase).toBe("PLAN");
        expect(result.state.selfReview).toBeNull(); // cleared for fresh loop
      }
    });

    it("reject at PLAN_REVIEW → TICKET", () => {
      const state = makeProgressedState("PLAN_REVIEW");
      const result = executeReviewDecision(state, {
        verdict: "reject",
        rationale: "Wrong approach",
        decidedBy: "reviewer-1",
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.phase).toBe("TICKET");
        expect(result.state.plan).toBeNull();
        expect(result.state.selfReview).toBeNull();
      }
    });

    it("changes_requested at EVIDENCE_REVIEW → IMPLEMENTATION", () => {
      const state = makeProgressedState("EVIDENCE_REVIEW");
      const result = executeReviewDecision(state, {
        verdict: "changes_requested",
        rationale: "Missing edge case",
        decidedBy: "reviewer-1",
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.phase).toBe("IMPLEMENTATION");
        expect(result.state.implementation).toBeNull();
        expect(result.state.implReview).toBeNull();
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    it("blocks in wrong phase", () => {
      const result = executeReviewDecision(makeState("TICKET"), {
        verdict: "approve",
        rationale: "ok",
        decidedBy: "r",
      }, ctx);
      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") expect(result.code).toBe("COMMAND_NOT_ALLOWED");
    });

    it("blocks on invalid verdict", () => {
      const state = makeProgressedState("PLAN_REVIEW");
      const result = executeReviewDecision(state, {
        verdict: "maybe" as any,
        rationale: "ok",
        decidedBy: "r",
      }, ctx);
      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") expect(result.code).toBe("INVALID_VERDICT");
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("four-eyes blocks when decidedBy === initiatedBy in regulated mode", () => {
      const state = makeProgressedState("PLAN_REVIEW");
      const regulatedCtx = { ...ctx, policy: REGULATED_POLICY };
      const result = executeReviewDecision(state, {
        verdict: "approve",
        rationale: "LGTM",
        decidedBy: state.initiatedBy, // same person
      }, regulatedCtx);
      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") expect(result.code).toBe("SELF_APPROVAL_FORBIDDEN");
    });

    it("four-eyes allows when decidedBy !== initiatedBy in regulated mode", () => {
      const state = makeProgressedState("PLAN_REVIEW");
      const regulatedCtx = { ...ctx, policy: REGULATED_POLICY };
      const result = executeReviewDecision(state, {
        verdict: "approve",
        rationale: "LGTM",
        decidedBy: "different-reviewer",
      }, regulatedCtx);
      expect(result.kind).toBe("ok");
    });

    it("reject at EVIDENCE_REVIEW clears everything back to TICKET", () => {
      const state = makeProgressedState("EVIDENCE_REVIEW");
      const result = executeReviewDecision(state, {
        verdict: "reject",
        rationale: "Start over",
        decidedBy: "r",
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.phase).toBe("TICKET");
        expect(result.state.plan).toBeNull();
        expect(result.state.implementation).toBeNull();
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe("EDGE", () => {
    it("team policy allows self-approval", () => {
      const state = makeProgressedState("PLAN_REVIEW");
      const teamCtx = { ...ctx, policy: TEAM_POLICY };
      const result = executeReviewDecision(state, {
        verdict: "approve",
        rationale: "ok",
        decidedBy: state.initiatedBy,
      }, teamCtx);
      expect(result.kind).toBe("ok");
    });

    it("records transition in result", () => {
      const state = makeProgressedState("PLAN_REVIEW");
      const result = executeReviewDecision(state, {
        verdict: "approve",
        rationale: "ok",
        decidedBy: "r",
      }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.transitions.length).toBe(1);
        expect(result.transitions[0]!.from).toBe("PLAN_REVIEW");
        expect(result.transitions[0]!.to).toBe("VALIDATION");
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("review-decision execution is fast (smoke test)", () => {
      const start = performance.now();
      executeReviewDecision(makeProgressedState("PLAN_REVIEW"), {
        verdict: "approve", rationale: "ok", decidedBy: "r",
      }, ctx);
      expect(performance.now() - start).toBeLessThan(50);
    });
  });
});

describe("abort rail", () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("aborts from any phase to COMPLETE with ABORTED error", () => {
      const phases = ["TICKET", "PLAN", "PLAN_REVIEW", "VALIDATION", "IMPLEMENTATION", "IMPL_REVIEW", "EVIDENCE_REVIEW"] as const;
      for (const phase of phases) {
        const state = makeState(phase);
        const result = executeAbort(state, { reason: "cancelled", actor: "user" }, ctx);
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
          expect(result.state.phase).toBe("COMPLETE");
          expect(result.state.error?.code).toBe("ABORTED");
        }
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe("BAD", () => {
    // Abort doesn't really have "bad" input — it always works
    it("uses default message when reason is empty", () => {
      const result = executeAbort(makeState("TICKET"), { reason: "", actor: "user" }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.error?.message).toBe("Session aborted");
      }
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe("CORNER", () => {
    it("idempotent at COMPLETE — returns terminal with no transitions", () => {
      const state = makeProgressedState("COMPLETE");
      const result = executeAbort(state, { reason: "again", actor: "user" }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.phase).toBe("COMPLETE");
        expect(result.transitions.length).toBe(0);
        expect(result.evalResult.kind).toBe("terminal");
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe("EDGE", () => {
    it("records ABORT transition bypassing topology", () => {
      const result = executeAbort(makeState("PLAN"), { reason: "stop", actor: "ci" }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.transitions.length).toBe(1);
        expect(result.transitions[0]!.event).toBe("ABORT");
        expect(result.transitions[0]!.from).toBe("PLAN");
        expect(result.transitions[0]!.to).toBe("COMPLETE");
      }
    });

    it("preserves existing evidence after abort", () => {
      const state = makeState("IMPLEMENTATION", { ticket: TICKET, plan: PLAN_RECORD });
      const result = executeAbort(state, { reason: "stop", actor: "user" }, ctx);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state.ticket).not.toBeNull();
        expect(result.state.plan).not.toBeNull();
      }
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe("PERF", () => {
    it("abort execution is fast (smoke test)", () => {
      const start = performance.now();
      executeAbort(makeState("PLAN"), { reason: "stop", actor: "user" }, ctx);
      expect(performance.now() - start).toBeLessThan(50);
    });
  });
});
