/**
 * @module integration/review-evidence-binding-fallback.test
 * @description Tests for BUG-20: Attestation-Free Fallback Binding

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
  attemptFor,
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
      verdict = 'accept',
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
      verdict = 'accept',
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
    const { iteration = 0, planVersion = 1, verdict = 'accept', usePlaceholder = false } = opts;

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

    return { state, obligation, attempts: [attemptFor(obligation, CHILD_SESSION_ID)] };
  }

  // ─── HAPPY ─────────────────────────────────────────────────────────────────

  it('HAPPY: bound via tool-fallback when attestation is completely absent', () => {
    const { state, obligation, attempts } = setupFallbackCycle();

    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });

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
    const { state, obligation, attempts } = setupFallbackCycle({ usePlaceholder: true });

    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });

    expect(result.evidence).not.toBeNull();
    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence!.obligationId).toBe(obligation.obligationId);
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  it('HAPPY: changes_requested verdict flows through fallback binding', () => {
    const { state, obligation, attempts } = setupFallbackCycle({ verdict: 'changes_requested' });

    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });

    expect(result.evidence).not.toBeNull();
    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence!.capturedVerdict).toBe('changes_requested');
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  // ─── BAD ───────────────────────────────────────────────────────────────────

  it('BAD: fallback with no unconsumed obligation of matching type → no_matching_obligation', () => {
    const { state, attempts } = setupFallbackCycle();

    // All obligations consumed — pass empty array
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [],
      invocations: [],
      attempts: attempts,
    });

    expect(result.evidence).toBeNull();
    expect(result.bindOutcome).toBe('no_matching_obligation');
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
    expect(result.diagnostic).toHaveProperty('availableObligations', 0);
  });

  it('BAD: fallback with only consumed obligations → no_matching_obligation', () => {
    const { state, attempts } = setupFallbackCycle();

    const consumedObligation = pendingObligation({
      status: 'consumed' as const,
      consumedAt: NOW,
    });

    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [consumedObligation],
      invocations: [],
      attempts: [attemptFor(consumedObligation, CHILD_SESSION_ID)],
    });

    expect(result.evidence).toBeNull();
    expect(result.bindOutcome).toBe('no_matching_obligation');
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  it('BAD: fallback iteration mismatch → field_mismatch', () => {
    // Reviewer produces iteration=0 but obligation has iteration=5
    const { state, attempts } = setupFallbackCycle({ iteration: 0 });

    const wrongIteration = pendingObligation({ iteration: 5, planVersion: 1 });

    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [wrongIteration],
      invocations: [],
      attempts: [attemptFor(wrongIteration, CHILD_SESSION_ID)],
    });

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

  it('EDGE: the attempt selects the obligation even when a newer unconsumed one exists', () => {
    // Recency used to decide which obligation received the evidence. Under
    // attempt-first resolution the recorded invocation envelope decides, which
    // is the stronger property: creating a newer obligation cannot divert
    // evidence away from the one the reviewer was actually invoked for.
    const { state, obligation, attempts } = setupFallbackCycle({ iteration: 0, planVersion: 1 });

    const newerObligation = pendingObligation({
      iteration: 0,
      planVersion: 1,
      createdAt: '2026-05-10T11:00:00.000Z',
    } as Partial<ReviewObligation>);

    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation, newerObligation],
      invocations: [],
      attempts: attempts,
    });

    expect(result.evidence).not.toBeNull();
    expect(result.bindOutcome).toBe('bound');
    // The attempt's obligation wins — NOT the newer one.
    expect(result.evidence!.obligationId).toBe(obligation.obligationId);
    expect(result.evidence!.obligationId).not.toBe(newerObligation.obligationId);
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  it('EDGE: valid UUID attestation whose obligation is absent → no_matching_obligation (no fallback to tool)', () => {
    // If the reviewer DID produce a valid UUID but the obligation it was invoked
    // for is gone, the bind fails outright. There is NO fallback — this prevents
    // stale attestations from accidentally binding to a different obligation.
    const { state, attempts } = setupFullCycle();

    // A different obligation is present; the attempt still references the one the
    // reviewer was actually invoked for, which is NOT in the list.
    const differentObligation = pendingObligation();

    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [differentObligation],
      invocations: [],
      attempts: attempts,
    });

    expect(result.evidence).toBeNull();
    expect(result.bindOutcome).toBe('no_matching_obligation');
    expect(result.diagnostic).toHaveProperty('bindingMode', 'attestation');
    expect(result.diagnostic).toHaveProperty('availableObligations', 1);
  });

  it('EDGE: an obligation of the wrong type is rejected, not bound', () => {
    const { state } = setupFallbackCycle();

    // Obligation is type 'implement' but tool is 'flowguard_plan' → oType = 'plan'
    const wrongType = pendingObligation({
      obligationType: 'implement' as const,
    } as Partial<ReviewObligation>);

    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [wrongType],
      invocations: [],
      attempts: [attemptFor(wrongType, CHILD_SESSION_ID)],
    });

    // Attempt-first resolution finds the obligation and then rejects it on the
    // type cross-check, which names both sides instead of a generic "no match".
    expect(result.evidence).toBeNull();
    expect(result.bindOutcome).toBe('field_mismatch');
    expect(result.diagnostic).toHaveProperty('attemptObligationType', 'implement');
    expect(result.diagnostic).toHaveProperty('enforcementObligationType', 'plan');
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
      overallVerdict: 'accept',
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

    const attempts = [attemptFor(obligation)];
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });

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
      overallVerdict: 'accept',
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

    const attempts = [attemptFor(obligation)];
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });

    expect(result.evidence).not.toBeNull();
    expect(result.bindOutcome).toBe('bound');
    expect(result.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  // ─── REGRESSION ────────────────────────────────────────────────────────────

  it('REGRESSION: valid attestation still binds via primary path (unchanged behavior)', () => {
    const { state, obligation, attempts } = setupFullCycle();

    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });

    expect(result.evidence).not.toBeNull();
    expect(result.bindOutcome).toBe('bound');
    expect(result.evidence!.obligationId).toBe(obligation.obligationId);
    expect(result.diagnostic).toHaveProperty('bindingMode', 'attestation');
  });

  it('REGRESSION: diverging mandateDigest with valid attestation binds host-authoritatively (not fatal)', () => {
    // Host-authoritative binding: the obligation is the authority for host constants,
    // so a divergence between the reviewer-echoed value and the obligation is surfaced
    // as hostConstantDivergence — never a fatal field_mismatch (parity with the
    // attestation-free path below, which also never treats host constants as fatal).
    const { state, obligation, attempts } = setupFullCycle();
    const divergentObligation = pendingObligation({
      obligationId: obligation.obligationId,
      iteration: 0,
      planVersion: 1,
      mandateDigest: 'wrong_digest_value',
    });

    const resultWithAttestation = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [divergentObligation],
      invocations: [],
      attempts: [attemptFor(divergentObligation, CHILD_SESSION_ID)],
    });
    expect(resultWithAttestation.bindOutcome).toBe('bound');
    expect(resultWithAttestation.diagnostic.hostConstantDivergence).toContain('mandateDigest');
    expect(resultWithAttestation.diagnostic).toHaveProperty('bindingMode', 'attestation');
    const fields = (resultWithAttestation.diagnostic.mismatchFields as string[] | undefined) ?? [];
    expect(fields).not.toContain('mandateDigest');
  });

  it('REGRESSION: field_mismatch for mandateDigest NOT triggered without attestation', () => {
    // Without attestation: mandateDigest not checked (would always fail)
    const { state, attempts } = setupFallbackCycle();
    const obligationWithCustomDigest = pendingObligation({
      iteration: 0,
      planVersion: 1,
      mandateDigest: 'some_completely_different_digest_that_would_normally_fail',
    });

    const resultNoAttestation = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligationWithCustomDigest],
      invocations: [],
      attempts: [attemptFor(obligationWithCustomDigest, CHILD_SESSION_ID)],
    });
    // Should BIND because mandateDigest is NOT checked in fallback mode
    expect(resultNoAttestation.evidence).not.toBeNull();
    expect(resultNoAttestation.bindOutcome).toBe('bound');
    expect(resultNoAttestation.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
  });

  // ─── SMOKE ─────────────────────────────────────────────────────────────────

  it('SMOKE: fallback binding is deterministic across repeated calls', () => {
    const { state, obligation, attempts } = setupFallbackCycle();

    const r1 = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });
    const r2 = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });

    expect(r1.bindOutcome).toBe('bound');
    expect(r2.bindOutcome).toBe('bound');
    expect(r1.evidence!.obligationId).toBe(r2.evidence!.obligationId);
    expect(r1.evidence!.findingsHash).toBe(r2.evidence!.findingsHash);
    expect(r1.diagnostic.bindingMode).toBe('tool_fallback');
  });

  it('SMOKE: fallback-bound evidence is consumable by resolveHostTaskFindings', () => {
    const { state, obligation, attempts } = setupFallbackCycle();

    const bindResult = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });
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
        attempts: [],
      }),
      bindResult.evidence!,
    );

    const resolved = resolveHostTaskFindings(assurance, obligation);

    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(resolved.findings.overallVerdict).toBe('accept');
    expect(resolved.findings.iteration).toBe(0);
    expect(resolved.findings.planVersion).toBe(1);
    expect(resolved.invocationId).toBe(bindResult.evidence!.invocationId);
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
      overallVerdict: 'accept',
      blockingIssues: [],
      majorRisks: [
        {
          severity: 'major',
          category: 'risk',
          message: 'No error handling for network failures',
          relation: {
            subjectAnchors: [
              { kind: 'repository_location', location: { path: 'src/foo.ts', revision: 'head' } },
            ],
            evidenceLocations: [],
          },
        },
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
    const attempts = [attemptFor(obligation, 'ses_reviewer_xyz')];
    const bindResult = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });

    expect(bindResult.evidence).not.toBeNull();
    expect(bindResult.bindOutcome).toBe('bound');
    expect(bindResult.evidence!.capturedRawFindings).toBeDefined();
    expect(
      (bindResult.evidence!.capturedRawFindings as Record<string, unknown>).overallVerdict,
    ).toBe('accept');

    // Step 4: Resolve findings from evidence (what plan.ts:380 does)
    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({ obligations: [obligation], invocations: [], attempts: [] }),
      bindResult.evidence!,
    );
    const resolved = resolveHostTaskFindings(assurance, obligation);

    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(resolved.findings.overallVerdict).toBe('accept');
    expect(resolved.findings.majorRisks).toHaveLength(1);
    expect(resolved.findings.missingVerification).toContain('Unit tests for auth flow');
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
      overallVerdict: 'accept',
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

    const attempts = [attemptFor(obligation, 'ses_child_real')];
    const bindResult = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });

    // BEFORE FIX: bindOutcome was 'no_attestation' or 'no_matching_obligation'
    // AFTER FIX: fallback binding succeeds
    expect(bindResult.evidence).not.toBeNull();
    expect(bindResult.bindOutcome).toBe('bound');
    expect(bindResult.diagnostic).toHaveProperty('bindingMode', 'tool_fallback');
    expect(bindResult.evidence!.obligationId).toBe(obligation.obligationId);
  });
});

// ─── Deterministic binding timestamps ────────────────────────────────────────
//
// No audit outcome of this state machine may read the system clock: every
// rejected attempt must carry exactly the host time that was injected, or the
// audit trail is not reproducible from its inputs.
describe('binding outcomes use the injected host time', () => {
  it('subject mismatch stales the attempt at the injected now', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
    const obligation = pendingObligation();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      taskResultWithAttestation(obligation.obligationId),
      LATER,
    );

    // The attempt names a different subject than the obligation it points at.
    const attempts = [attemptFor(obligation, undefined, { subjectDigest: 'other-subject' })];

    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts,
    });

    expect(result.bindOutcome).toBe('subject_mismatch');
    expect(result.attempt?.status).toBe('rejected');
    expect(result.attempt?.completedAt).toBe(LATER);
  });
});

// ─── Superseded attempts ─────────────────────────────────────────────────────
//
// A retry stales the attempt it supersedes. If that older reviewer session then
// calls back, its capture must be refused: otherwise one obligation could end up
// with two evidence records, one per session.
describe('a superseded attempt refuses a late callback', () => {
  it('reports stale_attempt for a staled attempt', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
    const obligation = pendingObligation();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      taskResultWithAttestation(obligation.obligationId),
      LATER,
    );

    const superseded = [attemptFor(obligation, undefined, { status: 'stale' })];

    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: superseded,
    });

    expect(result.bindOutcome).toBe('stale_attempt');
    expect(result.evidence).toBeNull();
  });

  it('reports stale_attempt for an expired attempt', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
    const obligation = pendingObligation();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      taskResultWithAttestation(obligation.obligationId),
      LATER,
    );

    const expired = [attemptFor(obligation, undefined, { status: 'expired' })];

    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: expired,
    });

    expect(result.bindOutcome).toBe('stale_attempt');
    expect(result.evidence).toBeNull();
  });

  it('is idempotent rather than additive for an already bound attempt', () => {
    // The same session calling back twice must not append a second record.
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
    const obligation = pendingObligation();
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt() },
      taskResultWithAttestation(obligation.obligationId),
      LATER,
    );

    const bound = [attemptFor(obligation, undefined, { status: 'bound' })];

    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: bound,
    });

    expect(result.bindOutcome).toBe('idempotent_bound');
    expect(result.evidence).toBeNull();
  });
});
