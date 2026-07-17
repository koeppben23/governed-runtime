/**
 * @module integration/review-evidence-binding-provenance.test
 * @description F8 tests: host-authoritative reviewer provenance.
 *
 * The reviewer subagent (an LLM) is NOT an authority for the review execution
 * time or its own session identity. It routinely confabulates both
 * (reviewedAt="...T00:00:00Z", reviewedBy.sessionId="flowguard-reviewer-session").
 * buildHostTaskEvidence MUST overwrite reviewedAt with the real invocation
 * timestamp and reviewedBy.sessionId with the resolved child session id, while
 * preserving the untrusted originals in reviewerClaimedAt / reviewerClaimedBy.
 *
 * @test-policy HAPPY, BAD, EDGE, REGRESSION — provenance authority contract.
 */

import { describe, it, expect } from 'vitest';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
} from './enforcement/enforcement.js';
import { buildHostTaskEvidence } from './evidence-binding.js';
import { REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';
import { REVIEW_MANDATE_DIGEST, REVIEW_CRITERIA_VERSION } from './assurance.js';
import { ReviewFindings } from '../../state/evidence.js';
import {
  NOW,
  LATER,
  SESSION_ID,
  CHILD_SESSION_ID,
  modeAResponse,
  validPrompt,
  pendingObligation,
} from '../plugin-host-task-diagnostics-helpers.js';

const CONFABULATED_AT = '2026-01-01T00:00:00.000Z';
const CONFABULATED_SESSION = 'flowguard-reviewer-session';

/**
 * Build a reviewer Task result whose reviewedAt / reviewedBy are confabulated —
 * i.e. a midnight timestamp and a guessed session id that do NOT match the real
 * host invocation.
 */
function confabulatedTaskResult(
  obligationId: string,
  opts: { iteration?: number; planVersion?: number } = {},
): string {
  const { iteration = 0, planVersion = 1 } = opts;
  return JSON.stringify({
    iteration,
    planVersion,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: {
      sessionId: CONFABULATED_SESSION,
      actorId: 'independent-security-reviewer',
      actorSource: 'git',
      actorAssurance: 'idp_verified',
    },
    reviewedAt: CONFABULATED_AT,
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

function setupConfabulatedCycle() {
  const state = createSessionState();
  onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);
  const obligation = pendingObligation();
  const taskResult = confabulatedTaskResult(obligation.obligationId);
  // Tier-1 host metadata carries the REAL child session id, exactly as the
  // OpenCode Task runtime provides it. This is the host-authoritative identity
  // that must win over the reviewer's confabulated reviewedBy.sessionId.
  onTaskToolAfter(
    state,
    { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
    taskResult,
    LATER,
    { metadata: { sessionID: CHILD_SESSION_ID }, callID: 'call_provenance_001' },
  );
  return { state, obligation };
}

describe('F8: host-authoritative reviewer provenance', () => {
  it('overwrites confabulated reviewedAt with the host invocation timestamp', () => {
    const { state, obligation } = setupConfabulatedCycle();
    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);

    expect(result.bindOutcome).toBe('bound');
    const raw = result.evidence?.capturedRawFindings as Record<string, unknown>;
    expect(raw.reviewedAt).toBe(LATER);
    expect(raw.reviewedAt).not.toBe(CONFABULATED_AT);
  });

  it('preserves the confabulated reviewedAt as untrusted reviewerClaimedAt', () => {
    const { state, obligation } = setupConfabulatedCycle();
    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    const raw = result.evidence?.capturedRawFindings as Record<string, unknown>;
    expect(raw.reviewerClaimedAt).toBe(CONFABULATED_AT);
  });

  it('overwrites the guessed reviewedBy.sessionId with the resolved child session id', () => {
    const { state, obligation } = setupConfabulatedCycle();
    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    const raw = result.evidence?.capturedRawFindings as Record<string, unknown>;
    const reviewedBy = raw.reviewedBy as Record<string, unknown>;
    expect(reviewedBy.sessionId).toBe(CHILD_SESSION_ID);
    expect(reviewedBy.sessionId).not.toBe(CONFABULATED_SESSION);
  });

  it('builds the ENTIRE reviewedBy block host-authoritatively — no model fields leak through', () => {
    const { state, obligation } = setupConfabulatedCycle();
    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    const raw = result.evidence?.capturedRawFindings as Record<string, unknown>;
    const reviewedBy = raw.reviewedBy as Record<string, unknown>;
    // The confabulated actorId/actorSource/actorAssurance MUST NOT survive.
    expect(reviewedBy).toEqual({
      sessionId: CHILD_SESSION_ID,
      actorId: REVIEWER_SUBAGENT_TYPE,
      actorSource: 'unknown',
      actorAssurance: 'best_effort',
    });
    expect(reviewedBy.actorId).not.toBe('independent-security-reviewer');
    expect(reviewedBy.actorSource).not.toBe('git');
    expect(reviewedBy.actorAssurance).not.toBe('idp_verified');
  });

  it('preserves the complete guessed reviewedBy as untrusted reviewerClaimedBy', () => {
    const { state, obligation } = setupConfabulatedCycle();
    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    const raw = result.evidence?.capturedRawFindings as Record<string, unknown>;
    const claimedBy = raw.reviewerClaimedBy as Record<string, unknown>;
    expect(claimedBy).toEqual({
      sessionId: CONFABULATED_SESSION,
      actorId: 'independent-security-reviewer',
      actorSource: 'git',
      actorAssurance: 'idp_verified',
    });
  });

  it('preserves reviewerClaimedBy even when the claimed sessionId matches the child session', () => {
    // Regression for the review finding: when the model echoes the correct
    // sessionId but confabulates actorId/actorSource/actorAssurance, the
    // original claim must still be retained (not silently dropped) and must not
    // leak into the canonical block.
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);
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
      reviewedBy: {
        sessionId: CHILD_SESSION_ID,
        actorId: 'independent-security-reviewer',
        actorSource: 'git',
        actorAssurance: 'idp_verified',
      },
      reviewedAt: LATER,
      attestation: {
        toolObligationId: obligation.obligationId,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        iteration: 0,
        planVersion: 1,
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
      },
    });
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      taskResult,
      LATER,
      { metadata: { sessionID: CHILD_SESSION_ID }, callID: 'call_provenance_003' },
    );
    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    const raw = result.evidence?.capturedRawFindings as Record<string, unknown>;
    const reviewedBy = raw.reviewedBy as Record<string, unknown>;
    expect(reviewedBy.actorSource).toBe('unknown');
    expect(reviewedBy.actorAssurance).toBe('best_effort');
    const claimedBy = raw.reviewerClaimedBy as Record<string, unknown>;
    expect(claimedBy).toEqual({
      sessionId: CHILD_SESSION_ID,
      actorId: 'independent-security-reviewer',
      actorSource: 'git',
      actorAssurance: 'idp_verified',
    });
  });

  it('produces capturedRawFindings that still satisfy the Zod ReviewFindings schema', () => {
    const { state, obligation } = setupConfabulatedCycle();
    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    const raw = result.evidence?.capturedRawFindings;
    const parsed = ReviewFindings.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it('omits reviewerClaimedAt when the reviewer time equals the host time, but still rebuilds reviewedBy', () => {
    // When the reviewer echoes a time equal to the binding time there is no
    // divergence to record — reviewerClaimedAt must stay absent.
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);
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
      reviewedAt: LATER,
      attestation: {
        toolObligationId: obligation.obligationId,
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: REVIEW_CRITERIA_VERSION,
        iteration: 0,
        planVersion: 1,
        reviewedBy: REVIEWER_SUBAGENT_TYPE,
      },
    });
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      taskResult,
      LATER,
      { metadata: { sessionID: CHILD_SESSION_ID }, callID: 'call_provenance_002' },
    );
    const result = buildHostTaskEvidence(state, SESSION_ID, [obligation], [], LATER);
    const raw = result.evidence?.capturedRawFindings as Record<string, unknown>;
    expect(raw.reviewedAt).toBe(LATER);
    // Time matches the host binding time → no divergent claimed time to record.
    expect(raw.reviewerClaimedAt).toBeUndefined();
    // The reviewedBy block is still model-supplied, so it is preserved verbatim
    // as reviewerClaimedBy (the block is always retained when present), while the
    // canonical reviewedBy is rebuilt host-authoritatively.
    expect(raw.reviewerClaimedBy).toEqual({ sessionId: CHILD_SESSION_ID });
    expect(raw.reviewedBy).toEqual({
      sessionId: CHILD_SESSION_ID,
      actorId: REVIEWER_SUBAGENT_TYPE,
      actorSource: 'unknown',
      actorAssurance: 'best_effort',
    });
  });
});
