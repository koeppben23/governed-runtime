/**
 * @module integration/review-evidence-binding-normalization.test
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
      verdict = 'accept',
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
    const { iteration = 0, planVersion = 1, verdict = 'accept', toolObligationId } = opts;

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
    expect(stored.overallVerdict).toBe('accept');
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
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(resolved.findings.overallVerdict).toBe('accept');
    expect(resolved.findings.iteration).toBe(0);
    expect(resolved.findings.planVersion).toBe(1);
    expect(resolved.findings.attestation).toBeUndefined();
    expect(resolved.invocationId).toBe(bindResult.evidence!.invocationId);
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
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(resolved.findings.overallVerdict).toBe('changes_requested');
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
    expect(resolveHostTaskFindings(assurance, obligation).kind).toBe('resolved');
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
      overallVerdict: 'accept',
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
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(resolved.findings.overallVerdict).toBe('accept');
  });

  it('EDGE: all non-attestation fields preserved exactly after strip', () => {
    const { state, obligation } = setupInvalidAttestationCycle();

    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    const stored = result.evidence!.capturedRawFindings as Record<string, unknown>;

    // Every field except attestation must be present and unchanged
    expect(stored.iteration).toBe(0);
    expect(stored.planVersion).toBe(1);
    expect(stored.reviewMode).toBe('subagent');
    expect(stored.overallVerdict).toBe('accept');
    expect(stored.blockingIssues).toEqual([]);
    expect(stored.majorRisks).toEqual([]);
    expect(stored.missingVerification).toEqual([]);
    expect(stored.scopeCreep).toEqual([]);
    expect(stored.unknowns).toEqual([]);
    expect(stored.reviewedBy).toEqual({ sessionId: CHILD_SESSION_ID });
    // F8: reviewedAt is host-authoritative — overwritten with the binding time
    // (LATER), not the reviewer-echoed NOW. The reviewer-claimed value diverges
    // from the host time here, so it is retained as untrusted reviewerClaimedAt.
    expect(stored.reviewedAt).toBe(LATER);
    expect(stored.reviewerClaimedAt).toBe(NOW);
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
      overallVerdict: 'accept',
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
    expect(resolveHostTaskFindings(assurance, obligation).kind).toBe('resolved');
  });

  it('CORNER: attestation is null — treated as absent, no strip error', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(), NOW);
    const obligation = pendingObligation();

    const nullAttestation = JSON.stringify({
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
    expect(resolveHostTaskFindings(assurance, obligation).kind).toBe('resolved');
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
      overallVerdict: 'accept',
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
    expect(stored.overallVerdict).toBe('accept');

    // Step 3: Persist + resolve (simulate what plan.ts:380 does)
    const assurance = appendInvocationEvidence(
      ensureReviewAssurance({ obligations: [obligation], invocations: [] }),
      bindResult.evidence!,
    );

    const resolved = resolveHostTaskFindings(assurance, obligation);

    // Step 4: THIS was broken before BUG-20b — now it works
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(resolved.findings.overallVerdict).toBe('accept');
    expect(resolved.findings.majorRisks).toHaveLength(1);
    expect(resolved.findings.missingVerification).toContain('Integration test coverage');
    expect(resolved.findings.attestation).toBeUndefined();
    expect(resolved.invocationId).toBe(bindResult.evidence!.invocationId);
  });

  it('E2E: full chain — invalid attestation normalized, hash consistent, resolve succeeds', () => {
    const { state, obligation } = setupInvalidAttestationCycle({ verdict: 'accept' });

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
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') throw new Error('expected resolved findings');
    expect(resolved.findings.overallVerdict).toBe('accept');

    // Verify no attestation leaked
    expect(resolved.findings.attestation).toBeUndefined();

    // Verify invocation identity
    expect(resolved.invocationId).toBe(bindResult.evidence!.invocationId);
  });
});
