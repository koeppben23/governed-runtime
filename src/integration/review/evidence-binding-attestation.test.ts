/**
 * @module integration/review-evidence-binding-attestation.test
 * @description Tests for BUG-20: Attestation-Free Fallback Binding
 * and BUG-20b: Invalid Attestation Normalization Before Storage.
 *
 * Validates that buildHostTaskEvidence correctly falls back to tool-based
 * obligation matching when attestation is absent or invalid, and that
 * invalid attestation fields are stripped before storage to ensure
 * downstream safeParse succeeds.
 *
 * @test-policy HAPPY, BAD, EDGE, CORNER, REGRESSION, SMOKE, E2E — all categories present.
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
import type { ReviewObligation } from '../../state/evidence.js';
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
// BUG-20: Attestation-Free Fallback Binding
// ═══════════════════════════════════════════════════════════════════════════════
//
// BUG-20 root cause: In host_task_required mode, the LLM-constructed reviewer
// prompt does NOT contain obligationId/mandateDigest/criteriaVersion because
// buildHostTaskPolicyOutput cannot include them (obligation is created separately).
// The reviewer writes placeholder values like "not_provided_in_prompt" which are
// not valid UUIDs. Previously this caused a hard failure at the no_attestation
// check (line 728-733), making the ENTIRE host_task_required flow broken.
//
// Fix: When attestation is missing or toolObligationId is not a valid UUID,
// fall back to tool-based obligation matching (by oType + unconsumed + newest).
// This is safe because:
// 1. Plugin validated this Task call via matchPendingReview (P34 1:1 contract)
// 2. rawFindings are first-party captured (not LLM-reconstructed)
// 3. At most one pending obligation per tool-type (plan/implement/architecture)
// ═══════════════════════════════════════════════════════════════════════════════

describe('BUG-20: attestation-free fallback binding', () => {
  // ─── Helper: task result WITHOUT attestation (real DeepSeek R1 behavior) ────

  /** Build task result mimicking real DeepSeek R1 output: valid findings, no attestation. */
  function taskResultWithoutAttestation(
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
      // NO attestation field — this is what DeepSeek R1 produces in host_task_required mode
    });
  }

  /** Build task result with INVALID attestation (placeholder values from LLM). */
  function taskResultWithPlaceholderAttestation(
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
        toolObligationId: 'not_provided_in_prompt',
        mandateDigest: 'not_provided',
        criteriaVersion: 'not_provided',
        iteration,
        planVersion,
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
      },
    });
  }

  /** Setup a full cycle without attestation (host_task_required real scenario). */
  function setupFallbackCycle(
    opts: {
      iteration?: number;
      planVersion?: number;
      verdict?: string;
      usePlaceholder?: boolean;
    } = {},
  ) {
    const { iteration = 0, planVersion = 1, verdict = 'approve', usePlaceholder = false } = opts;

    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(iteration, planVersion), NOW);

    const obligation = pendingObligation({ iteration, planVersion });

    const taskResult = usePlaceholder
      ? taskResultWithPlaceholderAttestation({ iteration, planVersion, verdict })
      : taskResultWithoutAttestation({ iteration, planVersion, verdict });

    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(iteration, planVersion) },
      taskResult,
      LATER,
    );

    return { state, obligation };
  }

  // ─── HAPPY ─────────────────────────────────────────────────────────────────

  it('HAPPY: bound via tool-fallback when attestation is completely absent', () => {
    const { state, obligation } = setupFallbackCycle();

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(result.evidence).not.toBeNull();
    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence!.obligationId).toBe(obligation.obligationId);
    expect(result.evidence!.invocationMode).toBe('host_subagent_task');
    expect(result.evidence!.hostVisible).toBe(true);
    expect(result.evidence!.capturedRawFindings).toBeDefined();
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
    expect(result.diagnostic).toHaveProperty('obligationId', obligation.obligationId);
  });

  it('HAPPY: bound via tool-fallback when toolObligationId is non-UUID placeholder (real BUG-20 case)', () => {
    // This is the EXACT scenario from the 2026-05-11 production log:
    // attestation.toolObligationId = "not_provided_in_prompt"
    const { state, obligation } = setupFallbackCycle({ usePlaceholder: true });

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(result.evidence).not.toBeNull();
    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence!.obligationId).toBe(obligation.obligationId);
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  it('HAPPY: changes_requested verdict flows through fallback binding', () => {
    const { state, obligation } = setupFallbackCycle({ verdict: 'changes_requested' });

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(result.evidence).not.toBeNull();
    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence!.capturedVerdict).toBe('changes_requested');
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  // ─── BAD ───────────────────────────────────────────────────────────────────

  it('BAD: fallback with no unconsumed obligation of matching type → no_matching_obligation', () => {
    const { state } = setupFallbackCycle();

    // All obligations consumed — pass empty array
    const result = buildHostTaskEvidence(state, SESSION_ID, [], [], LATER);

    expect(result.evidence).toBeNull();
    expect(result.bindOutcome).toBe('no_matching_obligation');
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
    expect(result.diagnostic).toHaveProperty('availableObligations', 0);
  });

  it('BAD: fallback with only consumed obligations → no_matching_obligation', () => {
    const { state } = setupFallbackCycle();

    const consumedObligation = pendingObligation({
      status: 'consumed' as const,
      consumedAt: NOW,
    });

    const result = buildHostTaskEvidence(state, SESSION_ID, [consumedObligation], [], LATER);

    expect(result.evidence).toBeNull();
    expect(result.bindOutcome).toBe('no_matching_obligation');
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  it('BAD: fallback iteration mismatch → field_mismatch', () => {
    // Reviewer produces iteration=0 but obligation has iteration=5
    const { state } = setupFallbackCycle({ iteration: 0 });

    const wrongIteration = pendingObligation({ iteration: 5, planVersion: 1 });

    const result = buildHostTaskEvidence(state, SESSION_ID, [wrongIteration], [], LATER);

    expect(result.evidence).toBeNull();
    expect(result.bindOutcome).toBe('field_mismatch');
    const fields = result.diagnostic.mismatchFields as string[];
    expect(fields).toContain('iteration');
    // mandateDigest/criteriaVersion/reviewedBy NOT checked (no valid attestation)
    expect(fields).not.toContain('mandateDigest');
    expect(fields).not.toContain('criteriaVersion');
    expect(fields).not.toContain('reviewedBy');
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  // ─── EDGE ──────────────────────────────────────────────────────────────────

  it('EDGE: fallback picks most recent obligation when multiple unconsumed exist (by createdAt)', () => {
    const { state } = setupFallbackCycle({ iteration: 0, planVersion: 1 });

    const olderObligation = pendingObligation({
      iteration: 0,
      planVersion: 1,
      createdAt: '2026-05-10T10:00:00.000Z',
    } as Partial<ReviewObligation>);
    const newerObligation = pendingObligation({
      iteration: 0,
      planVersion: 1,
      createdAt: '2026-05-10T11:00:00.000Z',
    } as Partial<ReviewObligation>);

    const result = buildHostTaskEvidence(
      state,
      SESSION_ID,
      [olderObligation, newerObligation],
      [],
      LATER,
    );

    expect(result.evidence).not.toBeNull();
    expect(result.bindOutcome).toBe('bound');
    // Should pick the NEWER obligation (sorted by createdAt descending)
    expect(result.evidence!.obligationId).toBe(newerObligation.obligationId);
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  it('EDGE: valid UUID attestation that does not match any obligation → no_matching_obligation (no fallback to tool)', () => {
    // If the reviewer DID produce a valid UUID but it doesn't match, the primary path
    // is used and fails. There is NO fallback — this prevents stale attestations from
    // accidentally binding to wrong obligations.
    const { state } = setupFullCycle();

    // The attestation in setupFullCycle has the correct obligation UUID, but we pass
    // a DIFFERENT obligation with a different ID
    const differentObligation = pendingObligation();

    const result = buildHostTaskEvidence(state, SESSION_ID, [differentObligation], [], LATER);

    expect(result.evidence).toBeNull();
    expect(result.bindOutcome).toBe('no_matching_obligation');
    expect(result.diagnostic).toHaveProperty('bindingMode', 'attestation');
  });

  it('EDGE: fallback skips obligations of wrong type', () => {
    const { state } = setupFallbackCycle();

    // Obligation is type 'implement' but tool is 'flowguard_plan' → oType = 'plan'
    const wrongType = pendingObligation({
      obligationType: 'implement' as const,
    } as Partial<ReviewObligation>);

    const result = buildHostTaskEvidence(state, SESSION_ID, [wrongType], [], LATER);

    expect(result.evidence).toBeNull();
    expect(result.bindOutcome).toBe('no_matching_obligation');
    expect(result.diagnostic).toHaveProperty('obligationType', 'plan');
  });

  // ─── CORNER ────────────────────────────────────────────────────────────────

  it('CORNER: attestation with empty string toolObligationId triggers fallback', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
    const obligation = pendingObligation();

    const taskResult = JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'approve',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: CHILD_SESSION_ID },
      reviewedAt: NOW,
      attestation: {
        toolObligationId: '', // empty string — not a UUID
        mandateDigest: '',
        criteriaVersion: '',
        iteration: 0,
        planVersion: 1,
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
      },
    });
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      taskResult,
      LATER,
    );

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(result.evidence).not.toBeNull();
    expect(result.bindOutcome).toBe('bound');
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  it('CORNER: attestation with UUID-like but invalid format triggers fallback', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
    const obligation = pendingObligation();

    const taskResult = JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'approve',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: CHILD_SESSION_ID },
      reviewedAt: NOW,
      attestation: {
        toolObligationId: '12345678-1234-1234-1234-12345678', // too short — not valid UUID
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        iteration: 0,
        planVersion: 1,
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
      },
    });
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      taskResult,
      LATER,
    );

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(result.evidence).not.toBeNull();
    expect(result.bindOutcome).toBe('bound');
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  // ─── REGRESSION ────────────────────────────────────────────────────────────

  it('REGRESSION: valid attestation still binds via primary path (unchanged behavior)', () => {
    const { state, obligation } = setupFullCycle();

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(result.evidence).not.toBeNull();
    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence!.obligationId).toBe(obligation.obligationId);
    expect(result.diagnostic).toHaveProperty('bindingMode', 'attestation');
  });

  it('REGRESSION: field_mismatch checks include mandateDigest/criteriaVersion ONLY with valid attestation', () => {
    // With valid attestation: all fields checked
    const { state, obligation } = setupFullCycle();
    const mismatchedObligation = pendingObligation({
      obligationId: obligation.obligationId,
      iteration: 0,
      planVersion: 1,
      mandateDigest: 'wrong_digest_value',
    });

    const resultWithAttestation = buildHostTaskEvidence(
      state,
      SESSION_ID,
      [mismatchedObligation],
      [],
      LATER,
    );
    expect(resultWithAttestation.bindOutcome).toBe('field_mismatch');
    expect(resultWithAttestation.diagnostic.mismatchFields).toContain('mandateDigest');
    expect(resultWithAttestation.diagnostic).toHaveProperty('bindingMode', 'attestation');
  });

  it('REGRESSION: field_mismatch for mandateDigest NOT triggered without attestation', () => {
    // Without attestation: mandateDigest not checked (would always fail)
    const { state } = setupFallbackCycle();
    const obligationWithCustomDigest = pendingObligation({
      iteration: 0,
      planVersion: 1,
      mandateDigest: 'some_completely_different_digest_that_would_normally_fail',
    });

    const resultNoAttestation = buildHostTaskEvidence(
      state,
      SESSION_ID,
      [obligationWithCustomDigest],
      [],
      LATER,
    );
    // Should BIND because mandateDigest is NOT checked in fallback mode
    expect(resultNoAttestation.evidence).not.toBeNull();
    expect(resultNoAttestation.bindOutcome).toBe('bound');
    expect(resultNoAttestation.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  // ─── SMOKE ─────────────────────────────────────────────────────────────────

  it('SMOKE: fallback binding is deterministic across repeated calls', () => {
    const { state, obligation } = setupFallbackCycle();

    const r1 = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    const r2 = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(r1.bindOutcome).toBe('bound');
    expect(r2.bindOutcome).toBe('bound');
    expect(r1.evidence!.obligationId).toBe(r2.evidence!.obligationId);
    expect(r1.evidence!.findingsHash).toBe(r2.evidence!.findingsHash);
    expect(r1.diagnostic.bindingMode).toBe('tool_fallback');
  });

  it('SMOKE: fallback-bound evidence is consumable by resolveHostTaskFindings', () => {
    const { state, obligation } = setupFallbackCycle();

    const bindResult = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(bindResult.evidence).not.toBeNull();

    // Simulate persisting and reading back
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
    expect(resolved!.findings.overallVerdict).toBe('approve');
    expect(resolved!.findings.iteration).toBe(0);
    expect(resolved!.findings.planVersion).toBe(1);
    expect(resolved!.invocationId).toBe(bindResult.evidence!.invocationId);
  });

  // ─── E2E ───────────────────────────────────────────────────────────────────

  it('E2E: full host_task_required flow without attestation — bind + resolve + consume', () => {
    // Simulates the EXACT flow from the 2026-05-11 production log:
    // 1. Plan Mode A → obligation created
    // 2. Task call → reviewer produces findings WITHOUT attestation
    // 3. buildHostTaskEvidence → fallback → bound
    // 4. resolveHostTaskFindings → finds evidence → returns findings
    // This is the flow that was 100% broken before BUG-20 fix.

    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);

    const obligation = pendingObligation({ iteration: 0, planVersion: 1 });

    // Reviewer output: real DeepSeek R1 format — valid findings, no attestation
    const reviewerOutput = JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'approve',
      blockingIssues: [],
      majorRisks: [
        { severity: 'major', category: 'risk', message: 'No error handling for network failures' },
      ],
      missingVerification: ['Unit tests for auth flow'],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'ses_reviewer_xyz' },
      reviewedAt: '2026-05-11T06:45:00.000Z',
      // attestation intentionally missing — real DeepSeek R1 behavior
    });

    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      reviewerOutput,
      LATER,
    );

    // Step 3: Build evidence — THIS IS THE FIX
    const bindResult = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(bindResult.evidence).not.toBeNull();
    expect(bindResult.bindOutcome).toBe('bound');
    expect(bindResult.evidence!.capturedRawFindings).toBeDefined();
    expect(
      (bindResult.evidence!.capturedRawFindings as Record<string, unknown>).overallVerdict,
    ).toBe('approve');

    // Step 4: Resolve findings from evidence (what plan.ts:380 does)
    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({ obligations: [obligation], invocations: [] }),
      bindResult.evidence!,
    );
    const resolved = resolveHostTaskFindings(assurance, obligation);

    expect(resolved).not.toBeNull();
    expect(resolved!.findings.overallVerdict).toBe('approve');
    expect(resolved!.findings.majorRisks).toHaveLength(1);
    expect(resolved!.findings.missingVerification).toContain('Unit tests for auth flow');
  });

  it('E2E: placeholder attestation from real log — "not_provided_in_prompt" triggers fallback', () => {
    // Exact reproduction of the 2026-05-11 log scenario:
    // attestedObligationId: "not_provided_in_prompt"
    // mandateDigest: "not_provided"
    // criteriaVersion: "not_provided"
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);

    const obligation = pendingObligation({ iteration: 0, planVersion: 1 });

    const reviewerOutput = JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'approve',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'ses_child_real' },
      reviewedAt: '2026-05-11T06:45:00.000Z',
      attestation: {
        toolObligationId: 'not_provided_in_prompt',
        mandateDigest: 'not_provided',
        criteriaVersion: 'not_provided',
        iteration: 0,
        planVersion: 1,
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
      },
    });

    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      reviewerOutput,
      LATER,
    );

    const bindResult = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    // BEFORE FIX: bindOutcome was 'no_attestation' or 'no_matching_obligation'
    // AFTER FIX: fallback binding succeeds
    expect(bindResult.evidence).not.toBeNull();
    expect(bindResult.bindOutcome).toBe('bound');
    expect(bindResult.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
    expect(bindResult.evidence!.obligationId).toBe(obligation.obligationId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-20b: Invalid Attestation Normalization Before Storage
// ═══════════════════════════════════════════════════════════════════════════════
//
// BUG-20b root cause: buildHostTaskEvidence (BUG-20 fix) correctly falls back
// to tool-based binding when attestation is invalid, but stores the raw findings
// INCLUDING the invalid attestation as capturedRawFindings. Later,
// resolveHostTaskFindings re-parses capturedRawFindings through
// ReviewFindingsSchema.safeParse(). The schema treats attestation as
// optional-but-must-be-valid: z.optional() means "absent OR fully valid",
// NOT "present-but-invalid is OK". So safeParse rejects the ENTIRE findings
// object because attestation.toolObligationId is not a UUID — even though
// binding succeeded and all other fields are valid.
//
// Fix: In buildHostTaskEvidence, when !hasValidAttestation, strip the attestation
// field from rawFindings BEFORE hashFindings and storage. This ensures:
// 1. capturedRawFindings is always schema-valid (attestation absent or valid)
// 2. findingsHash matches capturedRawFindings (both computed from same object)
// 3. resolveHostTaskFindings can safeParse successfully
// ═══════════════════════════════════════════════════════════════════════════════

describe('BUG-20b: invalid attestation normalization before storage', () => {
  // ─── Helper: task result with INVALID attestation (real LLM placeholder) ────

  /** Build reviewer output with placeholder attestation (exact 2026-05-11 real scenario). */
  function taskResultWithInvalidAttestation(
    opts: {
      childSessionId?: string;
      iteration?: number;
      planVersion?: number;
      verdict?: string;
      toolObligationId?: string;
    } = {},
  ): string {
    const {
      childSessionId = CHILD_SESSION_ID,
      iteration = 0,
      planVersion = 1,
      verdict = 'approve',
      toolObligationId = 'review-obligation-fg-rel-030',
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
        toolObligationId,
        mandateDigest: 'required',
        criteriaVersion: '1.0',
        iteration,
        planVersion,
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
      },
    });
  }

  /** Setup a full cycle with invalid attestation for BUG-20b testing. */
  function setupInvalidAttestationCycle(
    opts: {
      iteration?: number;
      planVersion?: number;
      verdict?: string;
      toolObligationId?: string;
    } = {},
  ) {
    const { iteration = 0, planVersion = 1, verdict = 'approve', toolObligationId } = opts;

    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(iteration, planVersion), NOW);

    const obligation = pendingObligation({ iteration, planVersion });

    const taskResult = taskResultWithInvalidAttestation({
      iteration,
      planVersion,
      verdict,
      toolObligationId,
    });

    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(iteration, planVersion) },
      taskResult,
      LATER,
    );

    return { state, obligation };
  }

  // ─── HAPPY ─────────────────────────────────────────────────────────────────

  it('HAPPY: invalid attestation stripped — capturedRawFindings has no attestation field', () => {
    const { state, obligation } = setupInvalidAttestationCycle();

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(result.evidence).not.toBeNull();
    expect(result.bindOutcome).toBe('bound');
    // capturedRawFindings should NOT have attestation (stripped)
    const stored = result.evidence!.capturedRawFindings as Record<string, unknown>;
    expect(stored).toBeDefined();
    expect(stored.attestation).toBeUndefined();
    expect(stored.overallVerdict).toBe('approve');
    expect(stored.iteration).toBe(0);
    expect(stored.planVersion).toBe(1);
  });

  it('HAPPY: stripped findings are consumable by resolveHostTaskFindings', () => {
    const { state, obligation } = setupInvalidAttestationCycle();

    const bindResult = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(bindResult.evidence).not.toBeNull();

    // Simulate persisting and reading back — the full consumption chain
    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({ obligations: [obligation], invocations: [] }),
      bindResult.evidence!,
    );

    const resolved = resolveHostTaskFindings(assurance, obligation);

    // THIS is what was broken before BUG-20b fix — safeParse rejected
    // because attestation.toolObligationId was not a UUID
    expect(resolved).not.toBeNull();
    expect(resolved!.findings.overallVerdict).toBe('approve');
    expect(resolved!.findings.iteration).toBe(0);
    expect(resolved!.findings.planVersion).toBe(1);
    expect(resolved!.findings.attestation).toBeUndefined();
    expect(resolved!.invocationId).toBe(bindResult.evidence!.invocationId);
  });

  it('HAPPY: changes_requested verdict flows through normalization + consumption', () => {
    const { state, obligation } = setupInvalidAttestationCycle({
      verdict: 'changes_requested',
    });

    const bindResult = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(bindResult.evidence).not.toBeNull();
    expect(bindResult.evidence!.capturedVerdict).toBe('changes_requested');

    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({ obligations: [obligation], invocations: [] }),
      bindResult.evidence!,
    );

    const resolved = resolveHostTaskFindings(assurance, obligation);
    expect(resolved).not.toBeNull();
    expect(resolved!.findings.overallVerdict).toBe('changes_requested');
  });

  // ─── BAD ───────────────────────────────────────────────────────────────────

  it('BAD: stripped findings with missing required field still fail safeParse correctly', () => {
    // rawFindings missing overallVerdict → even after strip, safeParse fails → null
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
    const obligation = pendingObligation();

    // Missing overallVerdict — this is genuinely broken output
    const brokenResult = JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      // overallVerdict: missing!
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: CHILD_SESSION_ID },
      reviewedAt: NOW,
    });

    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      brokenResult,
      LATER,
    );

    // extractCapturedFindings requires overallVerdict — returns null when missing.
    // With capturedFindings=null, the filter in buildHostTaskEvidence (line 680)
    // excludes the record from matched[], yielding no_matched_record.
    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(result.evidence).toBeNull();
    expect(result.bindOutcome).toBe('no_matched_record');
  });

  // ─── EDGE ──────────────────────────────────────────────────────────────────

  it('EDGE: attestation with "not_provided_in_prompt" is stripped (first BUG-20 scenario)', () => {
    const { state, obligation } = setupInvalidAttestationCycle({
      toolObligationId: 'not_provided_in_prompt',
    });

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(result.evidence).not.toBeNull();
    const stored = result.evidence!.capturedRawFindings as Record<string, unknown>;
    expect(stored.attestation).toBeUndefined();

    // Verify consumable
    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({ obligations: [obligation], invocations: [] }),
      result.evidence!,
    );
    expect(resolveHostTaskFindings(assurance, obligation)).not.toBeNull();
  });

  it('EDGE: findings without attestation at all — no strip needed, passes through', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
    const obligation = pendingObligation();

    // No attestation field whatsoever
    const noAttestationResult = JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'approve',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: CHILD_SESSION_ID },
      reviewedAt: NOW,
    });

    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      noAttestationResult,
      LATER,
    );

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(result.evidence).not.toBeNull();

    // No attestation in original → spread drops nothing → still consumable
    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({ obligations: [obligation], invocations: [] }),
      result.evidence!,
    );
    const resolved = resolveHostTaskFindings(assurance, obligation);
    expect(resolved).not.toBeNull();
    expect(resolved!.findings.overallVerdict).toBe('approve');
  });

  it('EDGE: all non-attestation fields preserved exactly after strip', () => {
    const { state, obligation } = setupInvalidAttestationCycle();

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    const stored = result.evidence!.capturedRawFindings as Record<string, unknown>;

    // Every field except attestation must be present and unchanged
    expect(stored.iteration).toBe(0);
    expect(stored.planVersion).toBe(1);
    expect(stored.reviewMode).toBe('subagent');
    expect(stored.overallVerdict).toBe('approve');
    expect(stored.blockingIssues).toEqual([]);
    expect(stored.majorRisks).toEqual([]);
    expect(stored.missingVerification).toEqual([]);
    expect(stored.scopeCreep).toEqual([]);
    expect(stored.unknowns).toEqual([]);
    expect(stored.reviewedBy).toEqual({ sessionId: CHILD_SESSION_ID });
    expect(stored.reviewedAt).toBe(NOW);
    // attestation stripped
    expect(stored.attestation).toBeUndefined();
  });

  // ─── CORNER ────────────────────────────────────────────────────────────────

  it('CORNER: attestation field is non-object (string) — treated as invalid, stripped', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
    const obligation = pendingObligation();

    const weirdAttestation = JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'approve',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: CHILD_SESSION_ID },
      reviewedAt: NOW,
      attestation: 'this is not an object',
    });

    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      weirdAttestation,
      LATER,
    );

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(result.evidence).not.toBeNull();

    // attestation was a string → toolObligationId extraction fails →
    // hasValidAttestation = false → strip → consumable
    const stored = result.evidence!.capturedRawFindings as Record<string, unknown>;
    expect(stored.attestation).toBeUndefined();

    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({ obligations: [obligation], invocations: [] }),
      result.evidence!,
    );
    expect(resolveHostTaskFindings(assurance, obligation)).not.toBeNull();
  });

  it('CORNER: attestation is null — treated as absent, no strip error', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
    const obligation = pendingObligation();

    const nullAttestation = JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'approve',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: CHILD_SESSION_ID },
      reviewedAt: NOW,
      attestation: null,
    });

    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      nullAttestation,
      LATER,
    );

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(result.evidence).not.toBeNull();

    // attestation: null → stripped → stored without attestation → consumable
    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({ obligations: [obligation], invocations: [] }),
      result.evidence!,
    );
    expect(resolveHostTaskFindings(assurance, obligation)).not.toBeNull();
  });

  // ─── REGRESSION ────────────────────────────────────────────────────────────

  it('REGRESSION: valid attestation is NOT stripped — primary path preserved', () => {
    const { state, obligation } = setupFullCycle();

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(result.evidence).not.toBeNull();
    expect(result.diagnostic).toHaveProperty('bindingMode', 'attestation');

    // Valid attestation MUST be preserved in capturedRawFindings
    const stored = result.evidence!.capturedRawFindings as Record<string, unknown>;
    expect(stored.attestation).toBeDefined();
    const att = stored.attestation as Record<string, unknown>;
    expect(att.toolObligationId).toBe(obligation.obligationId);
    expect(att.mandateDigest).toBe(REVIEW_MANDATE_DIGEST);
    expect(att.criteriaVersion).toBe(REVIEW_CRITERIA_VERSION);
  });

  it('REGRESSION: findingsHash matches capturedRawFindings after strip (consistency)', () => {
    const { state, obligation } = setupInvalidAttestationCycle();

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(result.evidence).not.toBeNull();

    // Hash was computed from normalized (stripped) findings.
    // Re-hashing capturedRawFindings must produce the same hash.
    const rehash = hashFindings(result.evidence!.capturedRawFindings!);
    expect(rehash).toBe(result.evidence!.findingsHash);
  });

  it('REGRESSION: findingsHash matches capturedRawFindings with valid attestation too', () => {
    const { state, obligation } = setupFullCycle();

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(result.evidence).not.toBeNull();

    // With valid attestation, normalizedFindings === rawFindings → hash consistent
    const rehash = hashFindings(result.evidence!.capturedRawFindings!);
    expect(rehash).toBe(result.evidence!.findingsHash);
  });

  // ─── SMOKE ─────────────────────────────────────────────────────────────────

  it('SMOKE: normalization is deterministic — same result on repeated builds', () => {
    const { state, obligation } = setupInvalidAttestationCycle();

    const r1 = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    const r2 = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(r1.evidence!.findingsHash).toBe(r2.evidence!.findingsHash);
    const s1 = r1.evidence!.capturedRawFindings as Record<string, unknown>;
    const s2 = r2.evidence!.capturedRawFindings as Record<string, unknown>;
    expect(s1.attestation).toBeUndefined();
    expect(s2.attestation).toBeUndefined();
    expect(s1.overallVerdict).toBe(s2.overallVerdict);
  });

  it('SMOKE: two reviewer outputs differing only in garbage attestation produce same hash', () => {
    // This proves dedup improvement: placeholder-A and placeholder-B
    // are semantically identical findings → same hash after normalization

    const state1 = createSessionState();
    onFlowGuardToolAfter(state1, 'flowguard_plan', {}, modeAResponse(), NOW);
    const obligation1 = pendingObligation();
    const taskResult1 = taskResultWithInvalidAttestation({
      toolObligationId: 'not_provided_in_prompt',
    });
    onTaskToolAfter(
      state1,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      taskResult1,
      LATER,
    );

    const state2 = createSessionState();
    onFlowGuardToolAfter(state2, 'flowguard_plan', {}, modeAResponse(), NOW);
    const obligation2 = pendingObligation();
    const taskResult2 = taskResultWithInvalidAttestation({
      toolObligationId: 'review-obligation-fg-rel-030',
    });
    onTaskToolAfter(
      state2,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      taskResult2,
      LATER,
    );

    const r1 = buildHostTaskEvidence(state1, SESSION_ID, [obligation1], [], LATER);
    const r2 = buildHostTaskEvidence(state2, SESSION_ID, [obligation2], [], LATER);

    // Both have different garbage attestation but identical core findings
    // After strip, hashes must match
    expect(r1.evidence!.findingsHash).toBe(r2.evidence!.findingsHash);
  });

  // ─── E2E ───────────────────────────────────────────────────────────────────

  it('E2E: exact reproduction of 2026-05-11 prod log — bind + normalize + store + resolve', () => {
    // This is the EXACT scenario that broke the real run:
    // 1. Reviewer produces attestation with toolObligationId = "review-obligation-fg-rel-030"
    // 2. buildHostTaskEvidence binds via fallback (BUG-20 fix)
    // 3. capturedRawFindings stored WITH invalid attestation
    // 4. resolveHostTaskFindings → safeParse FAILS because attestation.toolObligationId not UUID
    // 5. REVIEW_FINDINGS_REQUIRED error
    //
    // AFTER BUG-20b fix:
    // 3. Invalid attestation STRIPPED before storage
    // 4. resolveHostTaskFindings → safeParse SUCCEEDS
    // 5. Findings flow through to plan approval

    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);

    const obligation = pendingObligation({ iteration: 0, planVersion: 1 });

    const reviewerOutput = JSON.stringify({
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'approve',
      blockingIssues: [],
      majorRisks: [
        { severity: 'minor', category: 'quality', message: 'Consider adding more tests' },
      ],
      missingVerification: ['Integration test coverage'],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'ses_reviewer_real' },
      reviewedAt: '2026-05-11T06:45:00.000Z',
      attestation: {
        toolObligationId: 'review-obligation-fg-rel-030',
        mandateDigest: 'required',
        criteriaVersion: '1.0',
        iteration: 0,
        planVersion: 1,
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
      },
    });

    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      reviewerOutput,
      LATER,
    );

    // Step 1: Bind
    const bindResult = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(bindResult.evidence).not.toBeNull();
    expect(bindResult.bindOutcome).toBe('bound');
    expect(bindResult.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');

    // Step 2: Verify attestation stripped
    const stored = bindResult.evidence!.capturedRawFindings as Record<string, unknown>;
    expect(stored.attestation).toBeUndefined();
    expect(stored.overallVerdict).toBe('approve');

    // Step 3: Persist + resolve (simulate what plan.ts:380 does)
    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({ obligations: [obligation], invocations: [] }),
      bindResult.evidence!,
    );

    const resolved = resolveHostTaskFindings(assurance, obligation);

    // Step 4: THIS was broken before BUG-20b — now it works
    expect(resolved).not.toBeNull();
    expect(resolved!.findings.overallVerdict).toBe('approve');
    expect(resolved!.findings.majorRisks).toHaveLength(1);
    expect(resolved!.findings.missingVerification).toContain('Integration test coverage');
    expect(resolved!.findings.attestation).toBeUndefined();
    expect(resolved!.invocationId).toBe(bindResult.evidence!.invocationId);
  });

  it('E2E: full chain — invalid attestation normalized, hash consistent, resolve succeeds', () => {
    const { state, obligation } = setupInvalidAttestationCycle({ verdict: 'approve' });

    // Bind
    const bindResult = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    expect(bindResult.evidence).not.toBeNull();

    // Hash consistency
    const rehash = hashFindings(bindResult.evidence!.capturedRawFindings!);
    expect(rehash).toBe(bindResult.evidence!.findingsHash);

    // Persist
    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({ obligations: [obligation], invocations: [] }),
      bindResult.evidence!,
    );

    // Resolve
    const resolved = resolveHostTaskFindings(assurance, obligation);
    expect(resolved).not.toBeNull();
    expect(resolved!.findings.overallVerdict).toBe('approve');

    // Verify no attestation leaked
    expect(resolved!.findings.attestation).toBeUndefined();

    // Verify invocation identity
    expect(resolved!.invocationId).toBe(bindResult.evidence!.invocationId);
  });
});
