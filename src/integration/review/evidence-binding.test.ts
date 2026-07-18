/**
 * @module integration/review-evidence-binding.test
 * @description Tests for F5: Host-Task Binding Diagnostics + BUG-14: Tiered Session ID Resolution.
 *
 * Validates that `buildHostTaskEvidence()` returns structured
 * `HostTaskBindResult` with machine-readable `bindOutcome` and
 * serializable `diagnostic` metadata for every code path — enabling
 * the caller (`plugin.ts`) to log exactly why binding succeeded or failed.
 *
 * Also validates BUG-14 fix: tiered session ID resolution via TaskToolContext
 * ensures child session IDs are reliably resolved from metadata, text extraction,
 * or synthetic callID-based derivation.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, SMOKE, E2E — all categories present.
 */

import { describe, it, expect } from 'vitest';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
} from './enforcement/enforcement.js';
import { buildHostTaskEvidence } from './evidence-binding.js';
import {
  resolveSessionIdFromMetadata,
  injectSessionIdIntoOutput,
} from './enforcement/extraction.js';
import {
  REVIEW_REQUIRED_PREFIX,
  REVIEWER_SUBAGENT_TYPE,
  type HostTaskBindOutcome,
  type HostTaskBindResult,
  type TaskToolContext,
} from './enforcement/types.js';
import {
  createReviewObligation,
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  buildInvocationEvidence,
  appendInvocationEvidence,
  ensureReviewAssurance,
} from './assurance.js';
import type { ReviewObligation, ReviewInvocationEvidence } from '../../state/evidence.js';
import { validateReviewFindings } from '../tools/review-validation.js';
import { resolveHostTaskFindings } from '../tools/review-validation.js';

import {
  NOW,
  LATER,
  SESSION_ID,
  CHILD_SESSION_ID,
  modeAResponse,
  validPrompt,
  taskResultWithAttestation,
  pendingObligation,
  setupFullCycle,
} from '../plugin-host-task-diagnostics-helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// F5: buildHostTaskEvidence — HostTaskBindResult diagnostics
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
        overallVerdict: 'accept',
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

    it('no_attestation fallback — toolObligationId missing triggers tool-based matching', () => {
      const state = createSessionState();
      onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);

      const obligation = pendingObligation();

      const taskResultNoAttestation = JSON.stringify({
        iteration: 0,
        planVersion: 1,
        overallVerdict: 'accept',
        blockingIssues: [],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
        reviewedBy: { sessionId: CHILD_SESSION_ID },
        reviewedAt: NOW,
        // No attestation field → toolObligationId is null → fallback to tool matching
      });
      onTaskToolAfter(
        state,
        { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
        taskResultNoAttestation,
        LATER,
      );

      // BUG-20: With the fallback, this now BINDS successfully instead of failing
      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(result.evidence).not.toBeNull();
      expect(result.bindOutcome).toBe('bound');
      expect(result.diagnostic).toHaveProperty('obligationId', obligation.obligationId);
      expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
    });

    it('no_matching_obligation — attestedObligationId does not match any obligation', () => {
      const { state } = setupFullCycle();
      // Pass an empty obligations array → no match via attestation path
      const result = buildHostTaskEvidence(state, SESSION_ID, [], [], LATER);

      expect(result.evidence).toBeNull();
      expect(result.bindOutcome).toBe('no_matching_obligation');
      expect(result.diagnostic).toHaveProperty('attestedObligationId');
      expect(result.diagnostic).toHaveProperty('obligationType', 'plan');
      expect(result.diagnostic).toHaveProperty('availableObligations', 0);
      expect(result.diagnostic).toHaveProperty('bindingMode', 'attestation');
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

      // F8: buildHostTaskEvidence normalizes findings (host-authoritative
      // reviewedAt/reviewedBy + attestation consolidation) BEFORE hashing, so
      // the duplicate hash must be derived from the actually-bound evidence
      // rather than the raw reviewer findings.
      const firstBind = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
      expect(firstBind.bindOutcome).toBe('bound');
      const fHash = firstBind.evidence!.findingsHash;

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

    it('host-authoritative — confabulated mandateDigest binds, surfaced as divergence', () => {
      // Real reviewer behavior: the LLM was given the obligation UUID but not the
      // 64-hex mandateDigest, so it confabulated one. The obligation itself is correct.
      const { state, obligation } = setupFullCycle({
        attestationMandateDigest: '2a768e45-aef2-4951-b5aa-f178c78afcab',
      });

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      // Binds host-authoritatively instead of fatally rejecting on the echoed constant.
      expect(result.bindOutcome).toBe('bound');
      expect(result.evidence).not.toBeNull();
      expect(result.diagnostic.hostConstantDivergence).toContain('mandateDigest');

      // Persisted evidence carries the host-authoritative digest, not the confabulation.
      const att = result.evidence!.capturedRawFindings?.attestation as Record<string, unknown>;
      expect(att.mandateDigest).toBe(REVIEW_MANDATE_DIGEST);
      expect(att.criteriaVersion).toBe(REVIEW_CRITERIA_VERSION);
    });

    it('host-authoritative — confabulated criteriaVersion binds, surfaced as divergence', () => {
      const { state, obligation } = setupFullCycle({
        attestationCriteriaVersion: 'plan-review-v1',
      });

      const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

      expect(result.bindOutcome).toBe('bound');
      expect(result.diagnostic.hostConstantDivergence).toContain('criteriaVersion');
      const att = result.evidence!.capturedRawFindings?.attestation as Record<string, unknown>;
      expect(att.criteriaVersion).toBe(REVIEW_CRITERIA_VERSION);
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
        'no_matching_obligation',
        'field_mismatch',
        'duplicate_evidence',
      ];
      // Type assertion: all are valid
      for (const o of outcomes) {
        expect(typeof o).toBe('string');
      }
    });

    it('field_mismatch reports all cycle-binding mismatches; host constants are not fatal', () => {
      const { state, obligation } = setupFullCycle();

      // Mismatch iteration + planVersion (fatal) plus criteriaVersion (host constant).
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
      // Host-only constants are never fatal binding fields.
      expect(fields).not.toContain('criteriaVersion');
      expect(fields).not.toContain('mandateDigest');
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
          overallVerdict: 'accept',
          blockingIssuesCount: 0,
          sessionId: CHILD_SESSION_ID,
          rawFindings: { overallVerdict: 'accept' },
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

    it('confabulated reviewer attestation still resolves through the consume path', () => {
      // Reproduces the real run: the reviewer copied the obligation UUID into
      // mandateDigest and invented criteriaVersion. Binding must succeed AND the
      // bound evidence must resolve cleanly through resolveHostTaskFindings.
      const { state, obligation } = setupFullCycle({
        attestationMandateDigest: '2a768e45-aef2-4951-b5aa-f178c78afcab',
        attestationCriteriaVersion: 'plan-review-v1',
      });

      const bind = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
      expect(bind.bindOutcome).toBe('bound');
      expect(bind.diagnostic.hostConstantDivergence).toEqual(
        expect.arrayContaining(['mandateDigest', 'criteriaVersion']),
      );

      const assurance = appendInvocationEvidence(ensureReviewAssurance(undefined), bind.evidence!);
      const resolved = resolveHostTaskFindings(assurance, obligation);

      expect(resolved.kind).toBe('resolved');
      if (resolved.kind === 'resolved') {
        expect(resolved.findings.overallVerdict).toBe('accept');
        expect(resolved.findings.attestation?.mandateDigest).toBe(REVIEW_MANDATE_DIGEST);
        expect(resolved.findings.attestation?.criteriaVersion).toBe(REVIEW_CRITERIA_VERSION);
      }
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
    const { iteration = 0, planVersion = 1, verdict = 'accept' } = opts;
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
// Host-task deadlock recovery (structural re-arm) — END-TO-END
//
// Reproduces the exact live-demo failure and proves it now RECOVERS across the
// full pipeline: capture (onTaskToolAfter) → bind (buildHostTaskEvidence) →
// verdict resolution (resolveHostTaskFindings). Before the re-arm fix, the
// second reviewer run was discarded (write-once lock) and its re-bind was
// rejected as duplicate_evidence against the corrupt first capture — an
// unrecoverable deadlock.
// ═══════════════════════════════════════════════════════════════════════════════

describe('host-task deadlock recovery (structural re-arm, end-to-end)', () => {
  const CHILD_CORRUPT = 'ses_child_corrupt';
  const CHILD_VALID = 'ses_child_valid';

  /**
   * Valid JSON with overallVerdict present (so extraction/binding succeed) but a
   * MISTYPED required field — `majorRiskes` instead of `majorRisks` — so the
   * captured findings FAIL ReviewFindings.safeParse at verdict time. Mirrors the
   * reviewer typo that poisoned the demo obligation.
   */
  function corruptTaskResult(obligationId: string): string {
    return JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'accept',
      blockingIssues: [],
      majorRiskes: [], // typo → required `majorRisks` missing → unparseable at resolve
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: CHILD_CORRUPT },
      reviewedAt: NOW,
      attestation: {
        toolObligationId: obligationId,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        iteration: 0,
        planVersion: 1,
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
      },
    });
  }

  it('malformed first capture is recoverable: re-run binds fresh evidence (not duplicate) and the verdict resolves', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);
    const obligation = pendingObligation();

    // ── Reviewer run #1: malformed findings ─────────────────────────────────
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      corruptTaskResult(obligation.obligationId),
      LATER,
    );

    // Bind #1 succeeds — binding does NOT validate the ReviewFindings schema
    // (bind-before-validate), so the corrupt capture becomes a bound invocation.
    const bindCorrupt = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(bindCorrupt.bindOutcome).toBe('bound');
    expect(bindCorrupt.evidence).not.toBeNull();
    expect(bindCorrupt.evidence!.childSessionId).toBe(CHILD_CORRUPT);
    const invocations: ReviewInvocationEvidence[] = [bindCorrupt.evidence!];

    // Verdict resolution #1 → UNPARSEABLE (majorRisks missing). This is the
    // state that used to strand the obligation forever.
    const resolveCorrupt = resolveHostTaskFindings(
      { obligations: [obligation], invocations },
      obligation,
    );
    expect(resolveCorrupt.kind).toBe('unparseable');

    // ── Reviewer run #2 (re-run): valid findings, NEW child session ──────────
    const validResult = taskResultWithAttestation(obligation.obligationId, {
      childSessionId: CHILD_VALID,
    });
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      validResult,
      LATER,
    );

    // Bind #2 — the re-arm overwrote the corrupt capture with the valid one, so
    // this binds fresh evidence. New child session + new findings hash → NOT a
    // duplicate_evidence (this is precisely the deadlock that is now fixed).
    const bindValid = buildHostTaskEvidence(state, SESSION_ID, [obligation], invocations, LATER);
    expect(bindValid.bindOutcome).toBe('bound');
    expect(bindValid.evidence).not.toBeNull();
    expect(bindValid.evidence!.childSessionId).toBe(CHILD_VALID);
    invocations.push(bindValid.evidence!);

    // Verdict resolution #2 → RESOLVED. The resolver iterates all invocations,
    // skips the still-unparseable corrupt one, and returns the valid re-capture.
    const resolveValid = resolveHostTaskFindings(
      { obligations: [obligation], invocations },
      obligation,
    );
    expect(resolveValid.kind).toBe('resolved');
    if (resolveValid.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(resolveValid.findings.overallVerdict).toBe('accept');
    expect(resolveValid.invocation.childSessionId).toBe(CHILD_VALID);
  });
});
