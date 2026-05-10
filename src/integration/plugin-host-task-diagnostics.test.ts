/**
 * @module integration/plugin-host-task-diagnostics.test
 * @description Tests for F5: Host-Task Binding Diagnostics.
 *
 * Validates that `buildHostTaskEvidence()` returns structured
 * `HostTaskBindResult` with machine-readable `bindOutcome` and
 * serializable `diagnostic` metadata for every code path — enabling
 * the caller (`plugin.ts`) to log exactly why binding succeeded or failed.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, SMOKE, E2E — all categories present.
 */

import { describe, it, expect } from 'vitest';
import {
  buildHostTaskEvidence,
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
  REVIEW_REQUIRED_PREFIX,
  REVIEWER_SUBAGENT_TYPE,
  type HostTaskBindOutcome,
  type HostTaskBindResult,
} from './review-enforcement.js';
import {
  createReviewObligation,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  hashFindings,
  buildInvocationEvidence,
} from './review-assurance.js';
import type { ReviewObligation, ReviewInvocationEvidence } from '../state/evidence.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const NOW = '2026-05-10T12:00:00.000Z';
const LATER = '2026-05-10T12:01:00.000Z';
const SESSION_ID = 'ses_parent_001';
const CHILD_SESSION_ID = 'ses_child_001';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a Mode A response with INDEPENDENT_REVIEW_REQUIRED containing iteration and planVersion. */
function modeAResponse(iteration = 0, planVersion = 1): string {
  return JSON.stringify({
    phase: 'PLAN',
    status: `Plan submitted (v${planVersion}).`,
    selfReviewIteration: iteration,
    reviewMode: 'subagent',
    next:
      `${REVIEW_REQUIRED_PREFIX}: Call the flowguard-reviewer subagent via Task tool. ` +
      `Use subagent_type "flowguard-reviewer" with a prompt that includes: ` +
      `(1) the full plan text, (2) the ticket text, (3) iteration=${iteration}, ` +
      `(4) planVersion=${planVersion}.`,
  });
}

/** Build a substantive prompt for the subagent (meets MIN_SUBAGENT_PROMPT_LENGTH). */
function validPrompt(iteration = 0, planVersion = 1): string {
  return (
    `Review this plan critically. The plan proposes implementing a new feature ` +
    `for user authentication with OAuth2 integration. ` +
    `Ticket: PROJ-123 - Add OAuth2 login flow. ` +
    `iteration=${iteration}, planVersion=${planVersion}. ` +
    `Check for completeness, correctness, feasibility, risk, and quality. ` +
    `Return structured ReviewFindings JSON with your assessment.`
  );
}

/** Build task result JSON with review findings including attestation. */
function taskResultWithAttestation(
  obligationId: string,
  opts: {
    childSessionId?: string;
    iteration?: number;
    planVersion?: number;
    verdict?: string;
  } = {},
): string {
  const {
    childSessionId = CHILD_SESSION_ID,
    iteration = 0,
    planVersion = 1,
    verdict = 'approve',
  } = opts;
  return JSON.stringify({
    iteration,
    planVersion,
    reviewMode: 'subagent',
    overallVerdict: verdict,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: childSessionId },
    reviewedAt: NOW,
    attestation: {
      toolObligationId: obligationId,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
    },
  });
}

/** Create a pending obligation with matching iteration/planVersion/mandate/criteria. */
function pendingObligation(overrides: Partial<ReviewObligation> = {}): ReviewObligation {
  const base = createReviewObligation({
    obligationType: 'plan',
    iteration: 0,
    planVersion: 1,
    now: NOW,
  });
  return { ...base, ...overrides };
}

/**
 * Set up a full enforcement cycle: Mode A → Task call → enforcement state ready.
 * Returns the obligation and the enforcement state.
 */
function setupFullCycle(
  opts: {
    obligationId?: string;
    childSessionId?: string;
    iteration?: number;
    planVersion?: number;
  } = {},
) {
  const {
    obligationId: customObligationId,
    childSessionId = CHILD_SESSION_ID,
    iteration = 0,
    planVersion = 1,
  } = opts;

  const state = createSessionState();
  // Step 1: Mode A — FlowGuard tool signals INDEPENDENT_REVIEW_REQUIRED
  onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(iteration, planVersion), NOW);

  const obligation = pendingObligation({
    ...(customObligationId ? { obligationId: customObligationId } : {}),
    iteration,
    planVersion,
  });

  const taskResult = taskResultWithAttestation(obligation.obligationId, {
    childSessionId,
    iteration,
    planVersion,
  });

  // Step 2: Task call — onTaskToolAfter records subagent call
  onTaskToolAfter(
    state,
    {
      subagent_type: REVIEWER_SUBAGENT_TYPE,
      prompt: validPrompt(iteration, planVersion),
    },
    taskResult,
    LATER,
  );

  return { state, obligation };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildHostTaskEvidence — HostTaskBindResult diagnostics (F5)', () => {
  // ─── HAPPY ─────────────────────────────────────────────────

  describe('HAPPY', () => {
    it('bound — returns evidence with diagnostic metadata when all fields match', () => {
      const { state, obligation } = setupFullCycle();

      const result: HostTaskBindResult = buildHostTaskEvidence(
        state,
        SESSION_ID,
        [obligation],
        [],
        LATER,
      );

      expect(result.evidence).not.toBeNull();
      expect(result.bindOutcome).toBe('bound');
      expect(result.diagnostic).toHaveProperty('obligationId', obligation.obligationId);
      expect(result.diagnostic).toHaveProperty('childSessionId', CHILD_SESSION_ID);
      expect(result.diagnostic).toHaveProperty('findingsHash');
      expect(typeof result.diagnostic.findingsHash).toBe('string');

      // Evidence structural checks
      expect(result.evidence!.invocationMode).toBe('host_subagent_task');
      expect(result.evidence!.hostVisible).toBe(true);
      expect(result.evidence!.parentSessionId).toBe(SESSION_ID);
      expect(result.evidence!.childSessionId).toBe(CHILD_SESSION_ID);
      expect(result.evidence!.obligationId).toBe(obligation.obligationId);
      expect(result.evidence!.obligationType).toBe('plan');
    });
  });

  // ─── BAD ───────────────────────────────────────────────────

  describe('BAD', () => {
    it('no_matched_record — no pending review with subagentCalled + capturedFindings', () => {
      const state = createSessionState();
      // Mode A registered but no Task call made → subagentCalled=false
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);

      const result = buildHostTaskEvidence(state, SESSION_ID, [], [], LATER);

      expect(result.evidence).toBeNull();
      expect(result.bindOutcome).toBe('no_matched_record');
      expect(result.diagnostic).toHaveProperty('pendingCount', 1);
      expect(result.diagnostic).toHaveProperty('calledCount', 0);
    });

    it('no_child_session — subagentRecord.sessionId is null', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);

      // Task result without sessionId in reviewedBy → sessionId extraction returns null
      const taskResultNoSession = JSON.stringify({
        iteration: 0,
        planVersion: 1,
        overallVerdict: 'approve',
        blockingIssues: [],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
        reviewedBy: {},
        reviewedAt: NOW,
        attestation: {
          toolObligationId: 'obl-1',
          mandateDigest: REVIEW_MANDATE_DIGEST,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          reviewedBy: REVIEWER_SUBAGENT_TYPE,
        },
      });
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
        taskResultNoSession,
        LATER,
      );

      const result = buildHostTaskEvidence(state, SESSION_ID, [], [], LATER);

      expect(result.evidence).toBeNull();
      expect(result.bindOutcome).toBe('no_child_session');
      expect(result.diagnostic).toHaveProperty('tool', 'flowguard_plan');
    });

    it('no_attestation — toolObligationId missing from attestation', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);

      const taskResultNoAttestation = JSON.stringify({
        iteration: 0,
        planVersion: 1,
        overallVerdict: 'approve',
        blockingIssues: [],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
        reviewedBy: { sessionId: CHILD_SESSION_ID },
        reviewedAt: NOW,
        // No attestation field → toolObligationId is null
      });
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
        taskResultNoAttestation,
        LATER,
      );

      const result = buildHostTaskEvidence(state, SESSION_ID, [], [], LATER);

      expect(result.evidence).toBeNull();
      expect(result.bindOutcome).toBe('no_attestation');
      expect(result.diagnostic).toHaveProperty('hasAttestation', false);
      expect(result.diagnostic).toHaveProperty('childSessionId', CHILD_SESSION_ID);
    });

    it('no_matching_obligation — attestedObligationId does not match any obligation', () => {
      const { state } = setupFullCycle();
      // Pass an empty obligations array → no match
      const result = buildHostTaskEvidence(state, SESSION_ID, [], [], LATER);

      expect(result.evidence).toBeNull();
      expect(result.bindOutcome).toBe('no_matching_obligation');
      expect(result.diagnostic).toHaveProperty('attestedObligationId');
      expect(result.diagnostic).toHaveProperty('obligationType', 'plan');
      expect(result.diagnostic).toHaveProperty('availableObligations', 0);
    });

    it('field_mismatch — iteration mismatch between findings and obligation', () => {
      // Setup cycle with iteration=0
      const { state, obligation } = setupFullCycle({ iteration: 0, planVersion: 1 });

      // Pass obligation with iteration=5 → mismatch
      const mismatchedObligation = pendingObligation({
        obligationId: obligation.obligationId,
        iteration: 5,
        planVersion: 1,
      });

      const result = buildHostTaskEvidence(state, SESSION_ID, [mismatchedObligation], [], LATER);

      expect(result.evidence).toBeNull();
      expect(result.bindOutcome).toBe('field_mismatch');
      expect(result.diagnostic).toHaveProperty('attestedObligationId', obligation.obligationId);
      expect(result.diagnostic).toHaveProperty('mismatchFields');
      expect(result.diagnostic.mismatchFields).toContain('iteration');
    });

    it('duplicate_evidence — same childSessionId+findingsHash already exists', () => {
      const { state, obligation } = setupFullCycle();

      // Parse the findings from the task result to compute the hash
      const taskResult = taskResultWithAttestation(obligation.obligationId);
      const parsedFindings = JSON.parse(taskResult) as Record<string, unknown>;
      const fHash = hashFindings(parsedFindings);

      // Pre-existing invocation with same childSessionId + findingsHash
      const existingInvocation = buildInvocationEvidence({
        obligationId: obligation.obligationId,
        obligationType: 'plan',
        parentSessionId: SESSION_ID,
        childSessionId: CHILD_SESSION_ID,
        invocationMode: 'host_subagent_task',
        hostVisible: true,
        promptHash: 'dummy-hash',
        findingsHash: fHash,
        invokedAt: NOW,
        source: 'host-orchestrated',
      });

      const result = buildHostTaskEvidence(
        state,
        SESSION_ID,
        [obligation],
        [existingInvocation],
        LATER,
      );

      expect(result.evidence).toBeNull();
      expect(result.bindOutcome).toBe('duplicate_evidence');
      expect(result.diagnostic).toHaveProperty('childSessionId', CHILD_SESSION_ID);
      expect(result.diagnostic).toHaveProperty('findingsHash', fHash);
      expect(result.diagnostic).toHaveProperty('obligationId', obligation.obligationId);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────

  describe('CORNER', () => {
    it('multiple matched records — latest by completedAt wins', () => {
      const state = createSessionState();

      // Register Mode A signals for both plan and implement tools
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
      onFlowGuardToolAfter(state, 'flowguard_implement', {}, modeAResponse(), NOW);

      // Create obligation matching implement type (the latest tool)
      const obligation = pendingObligation({ obligationType: 'implement' });

      // First Task call (earlier timestamp) — matches plan pending review
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
        taskResultWithAttestation(obligation.obligationId, { childSessionId: 'ses_earlier' }),
        '2026-05-10T12:00:30.000Z',
      );

      // Second Task call (later timestamp) — matches implement pending review
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
        taskResultWithAttestation(obligation.obligationId, { childSessionId: 'ses_latest' }),
        '2026-05-10T12:01:00.000Z',
      );

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      // Should use the latest completedAt record (implement tool)
      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence).not.toBeNull();
      expect(result.evidence!.childSessionId).toBe('ses_latest');
      expect(result.evidence!.obligationType).toBe('implement');
    });

    it('field_mismatch — mandateDigest mismatch reported in diagnostic', () => {
      const { state, obligation } = setupFullCycle();

      const mismatchedObligation = pendingObligation({
        obligationId: obligation.obligationId,
        iteration: 0,
        planVersion: 1,
        mandateDigest: 'wrong-mandate-digest',
      });

      const result = buildHostTaskEvidence(state, SESSION_ID, [mismatchedObligation], [], LATER);

      expect(result.evidence).toBeNull();
      expect(result.bindOutcome).toBe('field_mismatch');
      expect(result.diagnostic.mismatchFields).toContain('mandateDigest');
    });

    it('empty enforcement state — no_matched_record with zero counts', () => {
      const state = createSessionState();
      const result = buildHostTaskEvidence(state, SESSION_ID, [], [], NOW);

      expect(result.evidence).toBeNull();
      expect(result.bindOutcome).toBe('no_matched_record');
      expect(result.diagnostic).toEqual({ pendingCount: 0, calledCount: 0 });
    });

    it('obligation with status consumed is excluded from matching', () => {
      const { state, obligation } = setupFullCycle();
      const consumed = pendingObligation({
        obligationId: obligation.obligationId,
        status: 'consumed',
        consumedAt: NOW,
      });

      const result = buildHostTaskEvidence(state, SESSION_ID, [consumed], [], LATER);

      expect(result.evidence).toBeNull();
      expect(result.bindOutcome).toBe('no_matching_obligation');
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────

  describe('EDGE', () => {
    it('diagnostic object is JSON-serializable — no circular refs', () => {
      const { state, obligation } = setupFullCycle();
      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      // Must not throw
      const serialized = JSON.stringify(result.diagnostic);
      expect(typeof serialized).toBe('string');
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      expect(parsed).toEqual(result.diagnostic);
    });

    it('all bindOutcome values are string literals — type narrowing works', () => {
      const outcomes: HostTaskBindOutcome[] = [
        'bound',
        'no_matched_record',
        'no_child_session',
        'no_obligation_type',
        'no_findings',
        'no_attestation',
        'no_matching_obligation',
        'field_mismatch',
        'duplicate_evidence',
      ];
      // Type assertion: all are valid
      for (const o of outcomes) {
        expect(typeof o).toBe('string');
      }
    });

    it('field_mismatch with multiple fields reports all mismatches', () => {
      const { state, obligation } = setupFullCycle();

      // Mismatch iteration, planVersion, criteriaVersion
      const mismatchedObligation = pendingObligation({
        obligationId: obligation.obligationId,
        iteration: 99,
        planVersion: 99,
        criteriaVersion: 'wrong-criteria',
      });

      const result = buildHostTaskEvidence(state, SESSION_ID, [mismatchedObligation], [], LATER);

      expect(result.bindOutcome).toBe('field_mismatch');
      const fields = result.diagnostic.mismatchFields as string[];
      expect(fields).toContain('iteration');
      expect(fields).toContain('planVersion');
      expect(fields).toContain('criteriaVersion');
    });

    it('no_obligation_type — unsupported tool in pending review', () => {
      const state = createSessionState();
      // Directly populate pendingReviews with an unsupported tool
      // Using flowguard_review which maps via TOOL_FLOWGUARD_REVIEW path
      // but a fabricated tool that doesn't match any reviewable tool
      const pending = state.pendingReviews as Map<string, unknown>;
      pending.set('unknown_tool' as never, {
        tool: 'unknown_tool',
        requestedAt: NOW,
        subagentCalled: true,
        subagentRecord: { sessionId: CHILD_SESSION_ID, completedAt: LATER },
        contentMeta: null,
        capturedFindings: {
          overallVerdict: 'approve',
          blockingIssuesCount: 0,
          sessionId: CHILD_SESSION_ID,
          rawFindings: { overallVerdict: 'approve' },
        },
      });

      const result = buildHostTaskEvidence(state, SESSION_ID, [], [], LATER);

      expect(result.evidence).toBeNull();
      expect(result.bindOutcome).toBe('no_obligation_type');
      expect(result.diagnostic).toHaveProperty('tool', 'unknown_tool');
    });
  });

  // ─── SMOKE ─────────────────────────────────────────────────

  describe('SMOKE', () => {
    it('full bind lifecycle — create obligation, run cycle, get evidence', () => {
      const { state, obligation } = setupFullCycle({
        iteration: 2,
        planVersion: 3,
      });

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      // Bound with correct fields
      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence).not.toBeNull();
      expect(result.evidence!.obligationType).toBe('plan');
      expect(result.evidence!.source).toBe('host-orchestrated');
      expect(result.evidence!.invocationMode).toBe('host_subagent_task');
      expect(result.evidence!.hostVisible).toBe(true);

      // Diagnostic is always present even on success
      expect(Object.keys(result.diagnostic).length).toBeGreaterThan(0);
    });
  });

  // ─── E2E ───────────────────────────────────────────────────

  describe('E2E', () => {
    it('successive bind attempts: first succeeds, second is duplicate', () => {
      const { state, obligation } = setupFullCycle();

      // First bind — should succeed
      const first = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
      expect(first.bindOutcome).toBe('bound');
      expect(first.evidence).not.toBeNull();

      // Second bind with same invocations list — should detect duplicate
      const second = buildHostTaskEvidence(
        state,
        SESSION_ID,
        [obligation],
        [first.evidence!],
        LATER,
      );
      expect(second.bindOutcome).toBe('duplicate_evidence');
      expect(second.evidence).toBeNull();
      expect(second.diagnostic).toHaveProperty('obligationId', obligation.obligationId);
    });

    it('implement tool obligation binds correctly (not just plan)', () => {
      const state = createSessionState();
      // Mode A for implement
      onFlowGuardToolAfter(state, 'flowguard_implement', {}, modeAResponse(1, 2), NOW);

      const obligation = pendingObligation({
        obligationType: 'implement',
        iteration: 1,
        planVersion: 2,
      });

      const taskResult = taskResultWithAttestation(obligation.obligationId, {
        iteration: 1,
        planVersion: 2,
      });
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(1, 2) },
        taskResult,
        LATER,
      );

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence).not.toBeNull();
      expect(result.evidence!.obligationType).toBe('implement');
    });
  });
});
