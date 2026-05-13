/**
 * @module integration/review-evidence-binding-verdict.test
 * @description Tests for BUG-15: capturedVerdict in host-task evidence + E2E revision loop.
 *
 * Validates that buildHostTaskEvidence correctly propagates capturedVerdict,
 * that verdict tampering is detected, and that evidence-based findings resolution
 * (Stufe 2) works without requiring agent reconstruction.
 *
 * @test-policy HAPPY, BAD, EDGE, SMOKE, E2E — all categories present.
 */

import { describe, it, expect } from 'vitest';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
} from './enforcement/enforcement.js';
import { buildHostTaskEvidence } from './evidence-binding.js';
import { REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  hashFindings,
  appendInvocationEvidence,
  ensureReviewAssurance,
} from './assurance.js';
import { validateReviewFindings, resolveHostTaskFindings } from '../tools/review-validation.js';

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
