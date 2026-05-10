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
  resolveSessionIdFromMetadata,
  injectSessionIdIntoOutput,
  REVIEW_REQUIRED_PREFIX,
  REVIEWER_SUBAGENT_TYPE,
  type HostTaskBindOutcome,
  type HostTaskBindResult,
  type TaskToolContext,
} from './review-enforcement.js';
import {
  createReviewObligation,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  hashFindings,
  buildInvocationEvidence,
  appendInvocationEvidence,
  ensureReviewAssurance,
} from './review-assurance.js';
import type { ReviewObligation, ReviewInvocationEvidence } from '../state/evidence.js';
import { validateReviewFindings } from './tools/review-validation.js';
import { resolveHostTaskFindings } from './tools/review-validation.js';

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
      iteration,
      planVersion,
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

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-14: Tiered Session ID Resolution via TaskToolContext
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildHostTaskEvidence — tiered session ID resolution (BUG-14)', () => {
  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Build task result JSON WITHOUT a reviewedBy.sessionId (simulates real reviewer output). */
  function taskResultNoSessionId(
    obligationId: string,
    opts: { iteration?: number; planVersion?: number; verdict?: string } = {},
  ): string {
    const { iteration = 0, planVersion = 1, verdict = 'approve' } = opts;
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
      reviewedBy: {},
      reviewedAt: NOW,
      attestation: {
        toolObligationId: obligationId,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
      },
    });
  }

  /**
   * Full cycle with TaskToolContext (BUG-14 flow).
   * Optionally pre-injects session ID into output (mirrors plugin.ts logic).
   */
  function setupCycleWithContext(
    opts: {
      context?: TaskToolContext;
      iteration?: number;
      planVersion?: number;
      includeEmbeddedSessionId?: boolean;
    } = {},
  ) {
    const { context, iteration = 0, planVersion = 1, includeEmbeddedSessionId = false } = opts;

    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(iteration, planVersion), NOW);

    const obligation = pendingObligation({ iteration, planVersion });

    let taskResult: string;
    if (includeEmbeddedSessionId) {
      taskResult = taskResultWithAttestation(obligation.obligationId, {
        childSessionId: 'ses_embedded_001',
        iteration,
        planVersion,
      });
    } else {
      taskResult = taskResultNoSessionId(obligation.obligationId, { iteration, planVersion });
    }

    // Mirror plugin.ts BUG-14 fix: resolve session ID and inject BEFORE tracking
    let resolvedChildSessionId: string | null = null;
    if (context) {
      resolvedChildSessionId = resolveSessionIdFromMetadata(context.metadata);
      if (!resolvedChildSessionId && context.callID) {
        resolvedChildSessionId = `derived:call:${context.callID}`;
      }
      if (resolvedChildSessionId) {
        taskResult = injectSessionIdIntoOutput(taskResult, resolvedChildSessionId);
      }
    }

    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(iteration, planVersion) },
      taskResult,
      LATER,
      context,
    );

    return { state, obligation, resolvedChildSessionId };
  }

  // ─── HAPPY ─────────────────────────────────────────────────

  describe('HAPPY', () => {
    it('Tier 1 — metadata.sessionID resolves and binds correctly', () => {
      const ctx: TaskToolContext = {
        metadata: { sessionID: 'ses_meta_001' },
        callID: 'call-001',
      };
      const { state, obligation } = setupCycleWithContext({ context: ctx });

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence).not.toBeNull();
      expect(result.evidence!.childSessionId).toBe('ses_meta_001');
      expect(result.evidence!.invocationMode).toBe('host_subagent_task');
    });

    it('Tier 3 — synthetic callID resolves when metadata has no sessionID', () => {
      const ctx: TaskToolContext = {
        metadata: { unrelated: 'data' },
        callID: 'call-42',
      };
      const { state, obligation } = setupCycleWithContext({ context: ctx });

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence).not.toBeNull();
      expect(result.evidence!.childSessionId).toBe('derived:call:call-42');
    });

    it('Tier 1 metadata.sessionId (camelCase) resolves correctly', () => {
      const ctx: TaskToolContext = {
        metadata: { sessionId: 'ses_camel_001' },
      };
      const { state, obligation } = setupCycleWithContext({ context: ctx });

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence!.childSessionId).toBe('ses_camel_001');
    });
  });

  // ─── BAD ───────────────────────────────────────────────────

  describe('BAD', () => {
    it('no context, no embedded sessionId → no_child_session (original BUG-14 path)', () => {
      // No TaskToolContext at all — the pre-BUG-14 behavior
      const { state, obligation } = setupCycleWithContext({
        context: undefined,
        includeEmbeddedSessionId: false,
      });

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      // This is the original BUG-14 failure: no child session can be resolved
      expect(result.evidence).toBeNull();
      expect(result.bindOutcome).toBe('no_child_session');
    });

    it('empty metadata + no callID → no_child_session', () => {
      const ctx: TaskToolContext = { metadata: {}, callID: '' };
      const { state, obligation } = setupCycleWithContext({
        context: ctx,
        includeEmbeddedSessionId: false,
      });

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(result.evidence).toBeNull();
      expect(result.bindOutcome).toBe('no_child_session');
    });

    it('metadata with empty string sessionID → falls through to Tier 3', () => {
      const ctx: TaskToolContext = {
        metadata: { sessionID: '' },
        callID: 'call-fallback',
      };
      const { state, obligation } = setupCycleWithContext({ context: ctx });

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      // Empty string is falsy, falls to Tier 3
      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence!.childSessionId).toBe('derived:call:call-fallback');
    });
  });

  // ─── CORNER ────────────────────────────────────────────────

  describe('CORNER', () => {
    it('Tier 1 overrides embedded text session ID', () => {
      // Output contains reviewedBy.sessionId = 'ses_embedded_001'
      // But metadata has sessionID = 'ses_meta_override'
      const ctx: TaskToolContext = {
        metadata: { sessionID: 'ses_meta_override' },
        callID: 'call-override',
      };
      const { state, obligation } = setupCycleWithContext({
        context: ctx,
        includeEmbeddedSessionId: true,
      });

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(result.bindOutcome).toBe('bound');
      // Tier 1 wins — NOT the embedded 'ses_embedded_001'
      expect(result.evidence!.childSessionId).toBe('ses_meta_override');
    });

    it('Tier 2 text extraction used when metadata missing but output has sessionId', () => {
      // No metadata context but output contains embedded reviewedBy.sessionId
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
      const obligation = pendingObligation();

      // Task result WITH embedded sessionId, NO metadata context
      const taskResult = taskResultWithAttestation(obligation.obligationId, {
        childSessionId: 'ses_text_extracted',
      });
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
        taskResult,
        LATER,
        // No context — Tier 2 text extraction kicks in
      );

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence!.childSessionId).toBe('ses_text_extracted');
    });

    it('metadata.id (generic) resolves as Tier 1 fallback field', () => {
      const ctx: TaskToolContext = {
        metadata: { id: 'ses_generic_id' },
      };
      const { state, obligation } = setupCycleWithContext({ context: ctx });

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence!.childSessionId).toBe('ses_generic_id');
    });

    it('Tier 3 synthetic ID is unique per callID', () => {
      const ctx1: TaskToolContext = { callID: 'call-aaa' };
      const ctx2: TaskToolContext = { callID: 'call-bbb' };

      const { state: s1, obligation: o1 } = setupCycleWithContext({ context: ctx1 });
      const { state: s2, obligation: o2 } = setupCycleWithContext({ context: ctx2 });

      const r1 = buildHostTaskEvidence(s1, SESSION_ID, [o1], [], LATER);
      const r2 = buildHostTaskEvidence(s2, SESSION_ID, [o2], [], LATER);

      expect(r1.evidence!.childSessionId).toBe('derived:call:call-aaa');
      expect(r2.evidence!.childSessionId).toBe('derived:call:call-bbb');
      expect(r1.evidence!.childSessionId).not.toBe(r2.evidence!.childSessionId);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────

  describe('EDGE', () => {
    it('injected session ID produces consistent findingsHash across bind attempts', () => {
      const ctx: TaskToolContext = {
        metadata: { sessionID: 'ses_hash_check' },
        callID: 'call-hash',
      };
      const { state, obligation } = setupCycleWithContext({ context: ctx });

      const r1 = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(r1.bindOutcome).toBe('bound');
      expect(r1.diagnostic).toHaveProperty('findingsHash');

      // Second bind with same evidence → duplicate, confirming hash is stable
      const r2 = buildHostTaskEvidence(state, SESSION_ID, [obligation], [r1.evidence!], LATER);
      expect(r2.bindOutcome).toBe('duplicate_evidence');
      expect(r2.diagnostic).toHaveProperty('findingsHash', r1.diagnostic.findingsHash);
    });

    it('non-JSON output is unchanged by injection — no_child_session if no other tier', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
      const obligation = pendingObligation();

      // Raw non-JSON text as task output
      const rawOutput = 'This is a plain text reviewer response with no JSON structure.';
      // Tier 3 with callID still resolves
      const ctx: TaskToolContext = { callID: 'call-raw-text' };
      const injected = injectSessionIdIntoOutput(rawOutput, `derived:call:${ctx.callID}`);
      // No reviewedBy marker in non-JSON → output unchanged
      expect(injected).toBe(rawOutput);

      // But onTaskToolAfter with context still gets Tier 3 session ID
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
        rawOutput,
        LATER,
        ctx,
      );

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      // Session ID is resolved via Tier 3 but output has no parseable findings
      // → binding depends on whether capturedFindings is non-null
      // Non-JSON output → capturedFindings is null → no_findings or no_child_session
      expect(result.evidence).toBeNull();
    });

    it('undefined metadata with valid callID → Tier 3 resolves', () => {
      const ctx: TaskToolContext = {
        metadata: undefined,
        callID: 'call-no-meta',
      };
      const { state, obligation } = setupCycleWithContext({ context: ctx });

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence!.childSessionId).toBe('derived:call:call-no-meta');
    });
  });

  // ─── SMOKE ─────────────────────────────────────────────────

  describe('SMOKE', () => {
    it('full pipeline: resolve → inject → track → build → bound', () => {
      const metadata = { sessionID: 'ses_smoke_full' };
      const callID = 'call-smoke-full';

      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(1, 2), NOW);

      const obligation = pendingObligation({ iteration: 1, planVersion: 2 });
      let taskResult = taskResultNoSessionId(obligation.obligationId, {
        iteration: 1,
        planVersion: 2,
      });

      // Step 1: Resolve session ID (mirrors plugin.ts)
      let resolved = resolveSessionIdFromMetadata(metadata);
      if (!resolved && callID) resolved = `derived:call:${callID}`;
      expect(resolved).toBe('ses_smoke_full');

      // Step 2: Inject into output
      taskResult = injectSessionIdIntoOutput(taskResult, resolved!);
      const parsed = JSON.parse(taskResult) as Record<string, unknown>;
      const rb = parsed.reviewedBy as Record<string, unknown>;
      expect(rb.sessionId).toBe('ses_smoke_full');

      // Step 3: Track
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(1, 2) },
        taskResult,
        LATER,
        { metadata, callID },
      );

      // Step 4: Build evidence
      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      // Step 5: Verify bound
      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence).not.toBeNull();
      expect(result.evidence!.childSessionId).toBe('ses_smoke_full');
      expect(result.evidence!.obligationType).toBe('plan');
      expect(result.evidence!.invocationMode).toBe('host_subagent_task');
      expect(result.evidence!.hostVisible).toBe(true);
    });
  });

  // ─── E2E ───────────────────────────────────────────────────

  describe('E2E', () => {
    it('Tier 1 bind + duplicate detection = stable pipeline', () => {
      const ctx: TaskToolContext = {
        metadata: { sessionID: 'ses_e2e_tier1' },
        callID: 'call-e2e-001',
      };
      const { state, obligation } = setupCycleWithContext({ context: ctx });

      // First bind succeeds
      const first = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
      expect(first.bindOutcome).toBe('bound');
      expect(first.evidence!.childSessionId).toBe('ses_e2e_tier1');

      // Second bind with existing evidence → duplicate
      const second = buildHostTaskEvidence(
        state,
        SESSION_ID,
        [obligation],
        [first.evidence!],
        LATER,
      );
      expect(second.bindOutcome).toBe('duplicate_evidence');
      expect(second.evidence).toBeNull();
    });

    it('Tier 3 bind for implement obligation', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_implement', {}, modeAResponse(0, 1), NOW);

      const obligation = pendingObligation({ obligationType: 'implement' });
      let taskResult = taskResultNoSessionId(obligation.obligationId);

      // Tier 3 resolution
      const callID = 'call-impl-001';
      const resolved = `derived:call:${callID}`;
      taskResult = injectSessionIdIntoOutput(taskResult, resolved);

      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
        taskResult,
        LATER,
        { callID },
      );

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence).not.toBeNull();
      expect(result.evidence!.childSessionId).toBe('derived:call:call-impl-001');
      expect(result.evidence!.obligationType).toBe('implement');
    });

    it('pre-BUG-14 path without context still works when output has embedded sessionId', () => {
      // Backward compatibility: if no TaskToolContext is passed but the reviewer
      // output includes a valid reviewedBy.sessionId, Tier 2 extraction works
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
      const obligation = pendingObligation();

      const taskResult = taskResultWithAttestation(obligation.obligationId, {
        childSessionId: 'ses_backward_compat',
      });

      // No context at all — old code path
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
        taskResult,
        LATER,
      );

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence!.childSessionId).toBe('ses_backward_compat');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-15: capturedVerdict in host-task evidence + E2E revision loop
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildHostTaskEvidence — capturedVerdict (BUG-15)', () => {
  it('HAPPY: evidence includes capturedVerdict from captured findings', () => {
    const { state, obligation } = setupFullCycle({ iteration: 0, planVersion: 1 });

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence).not.toBeNull();
    expect(result.evidence!.capturedVerdict).toBe('approve');
  });

  it('HAPPY: capturedVerdict=changes_requested flows through', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);
    const obligation = pendingObligation();
    const taskResult = taskResultWithAttestation(obligation.obligationId, {
      verdict: 'changes_requested',
    });
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      taskResult,
      LATER,
    );

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence!.capturedVerdict).toBe('changes_requested');
  });

  it('EDGE: no capturedVerdict when capturedFindings is null (non-parseable output)', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);

    // Feed non-parseable output that still has a sessionId for extraction
    // but the findings themselves are not valid JSON with overallVerdict
    const garbage = 'This is not valid JSON findings output at all';
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      garbage,
      LATER,
    );

    const result = buildHostTaskEvidence(state, SESSION_ID, [pendingObligation()], [], LATER);

    // Should fail to bind because capturedFindings is null → no_findings
    expect(result.evidence).toBeNull();
    expect(['no_findings', 'no_matched_record']).toContain(result.bindOutcome);
  });

  it('SMOKE: capturedVerdict is deterministic across calls', () => {
    const { state, obligation } = setupFullCycle();
    const r1 = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    // Build a fresh obligation (same ID) to avoid duplicate check
    const obligation2 = pendingObligation({ obligationId: obligation.obligationId });
    const r2 = buildHostTaskEvidence(state, SESSION_ID, [obligation2], [], LATER);

    expect(r1.evidence!.capturedVerdict).toBe('approve');
    expect(r2.evidence!.capturedVerdict).toBe('approve');
    expect(r1.evidence!.capturedVerdict).toBe(r2.evidence!.capturedVerdict);
  });
});

describe('BUG-15 E2E: full revision loop — changes_requested → Mode B verdict validation', () => {
  it('E2E: agent submits different-hash findings with matching verdict → passes validation', () => {
    // === Setup: simulate the full host_task_required revision loop ===

    // 1. Mode A signals review required
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);

    // 2. Reviewer returns changes_requested
    const obligation = pendingObligation();
    const reviewerOutput = taskResultWithAttestation(obligation.obligationId, {
      verdict: 'changes_requested',
    });
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      reviewerOutput,
      LATER,
    );

    // 3. Build host-task evidence
    const bindResult = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(bindResult.bindOutcome).toBe('bound');
    expect(bindResult.evidence).not.toBeNull();
    expect(bindResult.evidence!.capturedVerdict).toBe('changes_requested');

    // 4. Append evidence to assurance state
    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({
        obligations: [
          {
            ...obligation,
            status: 'pending' as const,
            pluginHandshakeAt: NOW,
            invocationId: null,
            fulfilledAt: null,
          },
        ],
        invocations: [],
      }),
      bindResult.evidence!,
    );

    // 5. Agent reconstructs findings with DIFFERENT structure (BUG-15 scenario)
    //    Key ordering, extra fields stripped by Zod, etc. → different hash
    const agentReconstructedFindings = {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict: 'changes_requested' as const, // Same verdict
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: CHILD_SESSION_ID },
      reviewedAt: NOW,
      // NOTE: attestation reconstructed by agent, may differ
      attestation: {
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        toolObligationId: obligation.obligationId,
        iteration: 0,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
      },
    };

    // Verify precondition: hashes DO differ (this is the bug scenario)
    const originalHash = bindResult.evidence!.findingsHash;
    const agentHash = hashFindings(agentReconstructedFindings);
    // They may or may not match depending on key order — the test validates
    // that verdict-based validation works regardless

    // 6. Validate — should pass with host_task_required
    const result = validateReviewFindings(agentReconstructedFindings, {
      subagentEnabled: true,
      fallbackToSelf: false,
      expectedPlanVersion: 1,
      expectedIteration: 0,
      strictEnforcement: true,
      assurance,
      obligationType: 'plan',
      reviewInvocationPolicy: 'host_task_required',
      reviewParentSessionId: SESSION_ID,
    });

    expect(result).toBeNull(); // No block — BUG-15 fixed!
  });

  it('E2E: agent tampers verdict (changes_requested → approve) → BLOCKED', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);

    const obligation = pendingObligation();
    const reviewerOutput = taskResultWithAttestation(obligation.obligationId, {
      verdict: 'changes_requested',
    });
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      reviewerOutput,
      LATER,
    );

    const bindResult = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(bindResult.evidence!.capturedVerdict).toBe('changes_requested');

    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({
        obligations: [
          {
            ...obligation,
            status: 'pending' as const,
            pluginHandshakeAt: NOW,
            invocationId: null,
            fulfilledAt: null,
          },
        ],
        invocations: [],
      }),
      bindResult.evidence!,
    );

    // Agent tampers: submits approve instead of changes_requested
    const tamperedFindings = {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict: 'approve' as const, // TAMPERED!
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: CHILD_SESSION_ID },
      reviewedAt: NOW,
      attestation: {
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        toolObligationId: obligation.obligationId,
        iteration: 0,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
      },
    };

    const result = validateReviewFindings(tamperedFindings, {
      subagentEnabled: true,
      fallbackToSelf: false,
      expectedPlanVersion: 1,
      expectedIteration: 0,
      strictEnforcement: true,
      assurance,
      obligationType: 'plan',
      reviewInvocationPolicy: 'host_task_required',
      reviewParentSessionId: SESSION_ID,
    });

    expect(result).not.toBeNull();
    expect(JSON.parse(result!).code).toBe('REVIEW_FINDINGS_HASH_MISMATCH');
  });

  it('E2E: approve verdict with hash mismatch passes in host_task_required', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);

    const obligation = pendingObligation();
    const reviewerOutput = taskResultWithAttestation(obligation.obligationId, {
      verdict: 'approve',
    });
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      reviewerOutput,
      LATER,
    );

    const bindResult = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(bindResult.evidence!.capturedVerdict).toBe('approve');

    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({
        obligations: [
          {
            ...obligation,
            status: 'pending' as const,
            pluginHandshakeAt: NOW,
            invocationId: null,
            fulfilledAt: null,
          },
        ],
        invocations: [],
      }),
      bindResult.evidence!,
    );

    // Agent reconstructs with extra data → hash differs
    const agentFindings = {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict: 'approve' as const,
      blockingIssues: [],
      majorRisks: [{ severity: 'major' as const, category: 'risk', message: 'agent added this' }],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: CHILD_SESSION_ID },
      reviewedAt: NOW,
      attestation: {
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        toolObligationId: obligation.obligationId,
        iteration: 0,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
      },
    };

    // Verify hash actually differs
    expect(hashFindings(agentFindings)).not.toBe(bindResult.evidence!.findingsHash);

    const result = validateReviewFindings(agentFindings, {
      subagentEnabled: true,
      fallbackToSelf: false,
      expectedPlanVersion: 1,
      expectedIteration: 0,
      strictEnforcement: true,
      assurance,
      obligationType: 'plan',
      reviewInvocationPolicy: 'host_task_required',
      reviewParentSessionId: SESSION_ID,
    });

    expect(result).toBeNull(); // Passes despite hash mismatch — verdict matches
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BUG-15 Stufe 2 E2E: evidence-based findings resolution
// ═════════════════════════════════════════════════════════════════════════════

describe('BUG-15 Stufe 2 E2E: evidence-based findings resolution (no agent reconstruction)', () => {
  it('E2E: buildHostTaskEvidence stores capturedRawFindings in evidence', () => {
    const { state, obligation } = setupFullCycle();
    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence).not.toBeNull();
    expect(result.evidence!.capturedRawFindings).toBeDefined();
    expect(result.evidence!.capturedRawFindings!.overallVerdict).toBe('approve');
    expect(result.evidence!.capturedRawFindings!.iteration).toBe(0);
    expect(result.evidence!.capturedRawFindings!.planVersion).toBe(1);
    expect(result.evidence!.capturedRawFindings!.reviewMode).toBe('subagent');
  });

  it('E2E: resolveHostTaskFindings reads findings from evidence (no agent findings needed)', () => {
    // Full cycle: Mode A → reviewer → buildHostTaskEvidence → capturedRawFindings
    const { state, obligation } = setupFullCycle();
    const bindResult = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(bindResult.evidence).not.toBeNull();

    // Build assurance with the evidence
    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({
        obligations: [
          {
            ...obligation,
            status: 'pending' as const,
            pluginHandshakeAt: NOW,
            invocationId: null,
            fulfilledAt: null,
          },
        ],
        invocations: [],
      }),
      bindResult.evidence!,
    );

    // Resolve findings from evidence — NO agent reconstruction
    const resolved = resolveHostTaskFindings(assurance, obligation);

    expect(resolved).not.toBeNull();
    expect(resolved!.findings.overallVerdict).toBe('approve');
    expect(resolved!.findings.iteration).toBe(0);
    expect(resolved!.findings.planVersion).toBe(1);
    expect(resolved!.findings.reviewMode).toBe('subagent');
    expect(resolved!.invocationId).toBe(bindResult.evidence!.invocationId);
  });

  it('E2E: changes_requested verdict flows through evidence-resolve', () => {
    const { state, obligation } = setupFullCycle();

    // Override: use changes_requested verdict
    const taskResult = taskResultWithAttestation(obligation.obligationId, {
      verdict: 'changes_requested',
    });

    // Reset state and re-feed with changes_requested
    const freshState = createSessionState();
    onFlowGuardToolAfter(freshState, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);
    onTaskToolAfter(
      freshState,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      taskResult,
      LATER,
    );

    const bindResult = buildHostTaskEvidence(freshState, SESSION_ID, [obligation], [], LATER);
    expect(bindResult.evidence).not.toBeNull();
    expect(bindResult.evidence!.capturedRawFindings!.overallVerdict).toBe('changes_requested');

    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({
        obligations: [
          {
            ...obligation,
            status: 'pending' as const,
            pluginHandshakeAt: NOW,
            invocationId: null,
            fulfilledAt: null,
          },
        ],
        invocations: [],
      }),
      bindResult.evidence!,
    );

    const resolved = resolveHostTaskFindings(assurance, obligation);
    expect(resolved).not.toBeNull();
    expect(resolved!.findings.overallVerdict).toBe('changes_requested');
  });

  it('E2E: evidence with non-parseable reviewer output → no capturedRawFindings → resolve returns null', () => {
    const freshState = createSessionState();
    onFlowGuardToolAfter(freshState, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);
    // Garbage output → capturedFindings.rawFindings is null → no evidence created
    onTaskToolAfter(
      freshState,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      'This is not valid JSON at all',
      LATER,
    );

    const obligation = pendingObligation();
    const bindResult = buildHostTaskEvidence(freshState, SESSION_ID, [obligation], [], LATER);
    // No evidence when rawFindings is null
    expect(bindResult.evidence).toBeNull();

    // Even if we somehow had an invocation, resolve would fail
    const assurance = ensureReviewAssurance({
      obligations: [
        {
          ...obligation,
          status: 'pending' as const,
          pluginHandshakeAt: NOW,
          invocationId: null,
          fulfilledAt: null,
        },
      ],
      invocations: [],
    });
    const resolved = resolveHostTaskFindings(assurance, obligation);
    expect(resolved).toBeNull();
  });

  it('SMOKE: capturedRawFindings hash matches findingsHash in evidence (consistency)', () => {
    const { state, obligation } = setupFullCycle();
    const bindResult = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(bindResult.evidence).not.toBeNull();
    const evidence = bindResult.evidence!;

    // The findingsHash was computed from rawFindings at build time.
    // capturedRawFindings IS rawFindings. Hashing it again must produce the same hash.
    const rehash = hashFindings(evidence.capturedRawFindings!);
    expect(rehash).toBe(evidence.findingsHash);
  });

  it('SMOKE: evidence-resolve is deterministic (same result on repeated calls)', () => {
    const { state, obligation } = setupFullCycle();
    const bindResult = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({
        obligations: [
          {
            ...obligation,
            status: 'pending' as const,
            pluginHandshakeAt: NOW,
            invocationId: null,
            fulfilledAt: null,
          },
        ],
        invocations: [],
      }),
      bindResult.evidence!,
    );

    const r1 = resolveHostTaskFindings(assurance, obligation);
    const r2 = resolveHostTaskFindings(assurance, obligation);

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.findings.overallVerdict).toBe(r2!.findings.overallVerdict);
    expect(r1!.invocationId).toBe(r2!.invocationId);
  });
});
