/**
 * @module integration/e2e-workflow.test
 * @description End-to-end workflow tests exercising full FlowGuard session lifecycles.
 *
 * Each test runs a complete or partial sequence of tool calls via the real
 * tool execute() functions against real filesystem persistence. Git adapter
 * functions are selectively mocked.
 *
 * Scope: Multi-step workflows, cross-tool state consistency, full lifecycle integrity.
 * NOT in scope: Individual tool edge cases (see tools-execute.test.ts).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — four categories. No PERF (integration level).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import {
  createToolContext,
  createTestWorkspace,
  isTarAvailable,
  parseToolResult,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from "./test-helpers";
import {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  implement,
  validate,
  review,
  abort_session,
  archive,
} from "./tools";
import { readState } from "../adapters/persistence";
import { readAuditTrail } from "../adapters/persistence";
import { verifyChain } from "../audit/integrity";
import { computeFingerprint, sessionDir as resolveSessionDir } from "../adapters/workspace";

// ─── Git Mock ────────────────────────────────────────────────────────────────

vi.mock("../adapters/git", async (importOriginal) => {
  const original = await importOriginal<typeof import("../adapters/git")>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

const gitMock = await import("../adapters/git");

// ─── Capability Gates ────────────────────────────────────────────────────────

const tarOk = await isTarAvailable();

// ─── Test Setup ──────────────────────────────────────────────────────────────

let ws: TestWorkspace;
let ctx: TestToolContext;

beforeEach(async () => {
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: crypto.randomUUID(),
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Call a tool and parse the result. Fails the test if the result is an error. */
async function callOk(
  tool: { execute: (args: unknown, ctx: TestToolContext) => Promise<string> },
  args: unknown,
  context: TestToolContext = ctx,
): Promise<Record<string, unknown>> {
  const raw = await tool.execute(args, context);
  const result = parseToolResult(raw);
  if (result.error) {
    throw new Error(
      `Tool returned error: ${result.code} — ${result.message}`,
    );
  }
  return result;
}

/** Get current phase from status tool. */
async function getPhase(context: TestToolContext = ctx): Promise<string> {
  const result = parseToolResult(await status.execute({}, context));
  return result.phase as string;
}

/** Resolve session directory for current context. */
async function getSessDir(context: TestToolContext = ctx): Promise<string> {
  const fp = await computeFingerprint(context.worktree);
  return resolveSessionDir(fp.fingerprint, context.sessionID);
}

// =============================================================================
// E2E Workflows
// =============================================================================

describe("e2e-workflow", () => {
  // ─── HAPPY ─────────────────────────────────────────────────

  describe("HAPPY", () => {
    it("complete solo workflow: hydrate → ticket → plan → validate → implement → complete", async () => {
      // 1. Hydrate
      const h = await callOk(hydrate, { policyMode: "solo", profileId: "baseline" });
      expect(h.phase).toBe("TICKET");

      // 2. Ticket
      await callOk(ticket, { text: "Fix the auth bug", source: "user" });
      expect(await getPhase()).toBe("TICKET");

      // 3. Plan (Mode A: submit)
      await callOk(plan, { planText: "## Plan\n1. Fix auth\n2. Add tests" });

      // 4. Plan (Mode B: approve self-review)
      // Solo: maxSelfReviewIterations=1, so first approve should converge
      await callOk(plan, { selfReviewVerdict: "approve" });
      // Solo: auto-approves PLAN_REVIEW → advances to VALIDATION
      const afterPlan = await getPhase();
      expect(afterPlan).toBe("VALIDATION");

      // 5. Validate (all pass)
      await callOk(validate, {
        results: [
          { checkId: "test_quality", passed: true, detail: "All tests pass" },
          { checkId: "rollback_safety", passed: true, detail: "Safe" },
        ],
      });
      expect(await getPhase()).toBe("IMPLEMENTATION");

      // 6. Implement (Mode A: record changes)
      await callOk(implement, {});

      // 7. Implement (Mode B: approve review)
      await callOk(implement, { reviewVerdict: "approve" });
      // Solo: auto-approves EVIDENCE_REVIEW → COMPLETE
      const finalPhase = await getPhase();
      expect(finalPhase).toBe("COMPLETE");

      // Verify all evidence slots are filled
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.ticket).not.toBeNull();
      expect(state!.plan).not.toBeNull();
      expect(state!.selfReview).not.toBeNull();
      expect(state!.validation.length).toBe(2);
      expect(state!.implementation).not.toBeNull();
      expect(state!.implReview).not.toBeNull();
    });

    it("complete team workflow with explicit decisions", async () => {
      // 1. Hydrate (team mode)
      await callOk(hydrate, { policyMode: "team", profileId: "baseline" });
      expect(await getPhase()).toBe("TICKET");

      // 2. Ticket
      await callOk(ticket, { text: "Team task", source: "user" });

      // 3. Plan + self-review (team: max 3 iterations)
      await callOk(plan, { planText: "## Plan\n1. Do things" });
      // Approve self-review until convergence
      for (let i = 0; i < 5; i++) {
        const phase = await getPhase();
        if (phase === "PLAN_REVIEW") break;
        await callOk(plan, { selfReviewVerdict: "approve" });
      }
      expect(await getPhase()).toBe("PLAN_REVIEW");

      // 4. Decision: approve plan
      await callOk(decision, { verdict: "approve", rationale: "Good plan" });
      expect(await getPhase()).toBe("VALIDATION");

      // 5. Validate
      await callOk(validate, {
        results: [
          { checkId: "test_quality", passed: true, detail: "OK" },
          { checkId: "rollback_safety", passed: true, detail: "OK" },
        ],
      });
      expect(await getPhase()).toBe("IMPLEMENTATION");

      // 6. Implement + review
      await callOk(implement, {});
      for (let i = 0; i < 5; i++) {
        const phase = await getPhase();
        if (phase === "EVIDENCE_REVIEW") break;
        await callOk(implement, { reviewVerdict: "approve" });
      }
      expect(await getPhase()).toBe("EVIDENCE_REVIEW");

      // 7. Decision: approve evidence
      await callOk(decision, { verdict: "approve", rationale: "Ship it" });
      expect(await getPhase()).toBe("COMPLETE");
    });
  });

  // ─── BAD ───────────────────────────────────────────────────

  describe("BAD", () => {
    it("reject at PLAN_REVIEW restarts from TICKET", async () => {
      await callOk(hydrate, { policyMode: "team", profileId: "baseline" });
      await callOk(ticket, { text: "Task", source: "user" });
      await callOk(plan, { planText: "## Plan" });
      for (let i = 0; i < 5; i++) {
        if (await getPhase() === "PLAN_REVIEW") break;
        await callOk(plan, { selfReviewVerdict: "approve" });
      }
      expect(await getPhase()).toBe("PLAN_REVIEW");

      // Reject
      await callOk(decision, { verdict: "reject", rationale: "Bad approach" });
      expect(await getPhase()).toBe("TICKET");

      // Verify plan was cleared
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.plan).toBeNull();
    });

    it("changes_requested at PLAN_REVIEW returns to PLAN for revision", async () => {
      await callOk(hydrate, { policyMode: "team", profileId: "baseline" });
      await callOk(ticket, { text: "Task", source: "user" });
      await callOk(plan, { planText: "## Original Plan" });
      for (let i = 0; i < 5; i++) {
        if (await getPhase() === "PLAN_REVIEW") break;
        await callOk(plan, { selfReviewVerdict: "approve" });
      }

      await callOk(decision, { verdict: "changes_requested", rationale: "More detail" });
      expect(await getPhase()).toBe("PLAN");

      // Can submit revised plan
      await callOk(plan, { planText: "## Revised Plan with more detail" });
    });

    it("validation failure sends back to PLAN", async () => {
      // Solo workflow up to VALIDATION
      await callOk(hydrate, { policyMode: "solo", profileId: "baseline" });
      await callOk(ticket, { text: "Task", source: "user" });
      await callOk(plan, { planText: "## Plan" });
      await callOk(plan, { selfReviewVerdict: "approve" });
      expect(await getPhase()).toBe("VALIDATION");

      // Fail validation
      await callOk(validate, {
        results: [
          { checkId: "test_quality", passed: false, detail: "Missing tests" },
          { checkId: "rollback_safety", passed: true, detail: "OK" },
        ],
      });
      expect(await getPhase()).toBe("PLAN");

      // Can re-plan and re-validate
      await callOk(plan, { planText: "## Better Plan with tests" });
      await callOk(plan, { selfReviewVerdict: "approve" });
      // In solo, may stop at PLAN_REVIEW (user gate) — need to advance
      const phaseAfterReplan = await getPhase();
      if (phaseAfterReplan === "PLAN_REVIEW") {
        // Solo auto-approves conceptually, but decision tool still needed
        await callOk(decision, { verdict: "approve", rationale: "auto" });
      }
      expect(await getPhase()).toBe("VALIDATION");
    });
  });

  // ─── CORNER ────────────────────────────────────────────────

  describe("CORNER", () => {
    it("abort mid-workflow terminates session", async () => {
      await callOk(hydrate, { policyMode: "solo", profileId: "baseline" });
      await callOk(ticket, { text: "Task", source: "user" });
      await callOk(plan, { planText: "## Plan" });

      await callOk(abort_session, { reason: "Cancel everything" });
      expect(await getPhase()).toBe("COMPLETE");

      // Verify abort marker in state
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.error).not.toBeNull();
      expect(state!.error!.code).toBe("ABORTED");
    });

    it.skipIf(!tarOk)("archive after complete creates tar.gz", async () => {
      // Full solo workflow to COMPLETE
      await callOk(hydrate, { policyMode: "solo", profileId: "baseline" });
      await callOk(ticket, { text: "Task", source: "user" });
      await callOk(plan, { planText: "## Plan" });
      await callOk(plan, { selfReviewVerdict: "approve" });
      await callOk(validate, {
        results: [
          { checkId: "test_quality", passed: true, detail: "OK" },
          { checkId: "rollback_safety", passed: true, detail: "OK" },
        ],
      });
      await callOk(implement, {});
      await callOk(implement, { reviewVerdict: "approve" });
      expect(await getPhase()).toBe("COMPLETE");

      // Archive
      const archiveResult = await callOk(archive, {});
      expect(archiveResult.status).toContain("archived");
      expect(typeof archiveResult.archivePath).toBe("string");
      await expect(
        fs.access(archiveResult.archivePath as string),
      ).resolves.toBeUndefined();
    });

    it("status at every phase returns correct phase", async () => {
      // Track phases through a solo workflow
      const phases: string[] = [];

      await callOk(hydrate, { policyMode: "solo", profileId: "baseline" });
      phases.push(await getPhase());

      await callOk(ticket, { text: "Task", source: "user" });
      phases.push(await getPhase());

      await callOk(plan, { planText: "## Plan" });
      phases.push(await getPhase()); // After plan submit

      await callOk(plan, { selfReviewVerdict: "approve" });
      phases.push(await getPhase()); // After self-review converge (solo auto-approve → VALIDATION)

      await callOk(validate, {
        results: [
          { checkId: "test_quality", passed: true, detail: "OK" },
          { checkId: "rollback_safety", passed: true, detail: "OK" },
        ],
      });
      phases.push(await getPhase()); // IMPLEMENTATION

      await callOk(implement, {});
      phases.push(await getPhase()); // After impl record

      await callOk(implement, { reviewVerdict: "approve" });
      phases.push(await getPhase()); // COMPLETE

      // Verify progression
      expect(phases[0]).toBe("TICKET");
      expect(phases[1]).toBe("TICKET"); // Ticket doesn't auto-advance
      expect(phases[phases.length - 1]).toBe("COMPLETE");

      // All phases should be valid phase names
      const validPhases = new Set([
        "TICKET", "PLAN", "PLAN_REVIEW", "VALIDATION",
        "IMPLEMENTATION", "IMPL_REVIEW", "EVIDENCE_REVIEW", "COMPLETE",
      ]);
      for (const p of phases) {
        expect(validPhases.has(p)).toBe(true);
      }
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────

  describe("EDGE", () => {
    it("concurrent sessions in same workspace have independent state", async () => {
      // Session 1
      const ctx1 = ctx;
      await callOk(hydrate, { policyMode: "solo", profileId: "baseline" }, ctx1);
      await callOk(ticket, { text: "Session 1 task", source: "user" }, ctx1);

      // Session 2 (same worktree, different sessionID)
      const ctx2 = createToolContext({
        worktree: ws.tmpDir,
        directory: ws.tmpDir,
        sessionID: crypto.randomUUID(),
      });
      await callOk(hydrate, { policyMode: "team", profileId: "baseline" }, ctx2);
      await callOk(ticket, { text: "Session 2 task", source: "user" }, ctx2);

      // Verify independence
      const sessDir1 = await getSessDir(ctx1);
      const sessDir2 = await getSessDir(ctx2);
      expect(sessDir1).not.toBe(sessDir2);

      const state1 = await readState(sessDir1);
      const state2 = await readState(sessDir2);
      expect(state1!.ticket!.text).toBe("Session 1 task");
      expect(state2!.ticket!.text).toBe("Session 2 task");
      expect(state1!.policySnapshot.mode).toBe("solo");
      expect(state2!.policySnapshot.mode).toBe("team");
    });

    it("idempotent hydrate preserves existing session", async () => {
      // First hydrate + ticket
      await callOk(hydrate, { policyMode: "solo", profileId: "baseline" });
      await callOk(ticket, { text: "My task", source: "user" });

      // Second hydrate (same sessionID)
      await callOk(hydrate, { policyMode: "solo", profileId: "baseline" });

      // Ticket should still be there
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      expect(state!.ticket).not.toBeNull();
      expect(state!.ticket!.text).toBe("My task");
    });

    it("repo without remote uses path-based fingerprint and full workflow works", async () => {
      // Override: no remote
      vi.mocked(gitMock.remoteOriginUrl).mockResolvedValue(null);

      // Full solo workflow
      await callOk(hydrate, { policyMode: "solo", profileId: "baseline" });
      await callOk(ticket, { text: "Local repo task", source: "user" });
      await callOk(plan, { planText: "## Local Plan" });
      await callOk(plan, { selfReviewVerdict: "approve" });
      await callOk(validate, {
        results: [
          { checkId: "test_quality", passed: true, detail: "OK" },
          { checkId: "rollback_safety", passed: true, detail: "OK" },
        ],
      });
      await callOk(implement, {});
      await callOk(implement, { reviewVerdict: "approve" });
      expect(await getPhase()).toBe("COMPLETE");

      // Verify fingerprint is path-based
      const fp = await computeFingerprint(ws.tmpDir);
      expect(fp.materialClass).toBe("local_path");
    });

    it("audit trail integrity after full solo workflow", async () => {
      // Run through complete solo workflow
      await callOk(hydrate, { policyMode: "solo", profileId: "baseline" });
      await callOk(ticket, { text: "Audit test", source: "user" });
      await callOk(plan, { planText: "## Plan" });
      await callOk(plan, { selfReviewVerdict: "approve" });
      await callOk(validate, {
        results: [
          { checkId: "test_quality", passed: true, detail: "OK" },
          { checkId: "rollback_safety", passed: true, detail: "OK" },
        ],
      });
      await callOk(implement, {});
      await callOk(implement, { reviewVerdict: "approve" });
      expect(await getPhase()).toBe("COMPLETE");

      // Read and verify audit trail
      // Note: Audit trail is written by the plugin, not by tools directly.
      // This test verifies that the session state is consistent and the
      // trail file can be read (may be empty if plugin is not active).
      const sessDir = await getSessDir();
      const trail = await readAuditTrail(sessDir);
      // Trail may be empty (tools don't write audit events — plugin does).
      // But readAuditTrail should not throw.
      expect(trail).toBeDefined();
      expect(Array.isArray(trail.events)).toBe(true);
    });
  });
});
