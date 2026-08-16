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
import { ReviewFindings } from '../../state/evidence.js';
import {
  NOW,
  LATER,
  SESSION_ID,
  CHILD_SESSION_ID,
  modeAResponse,
  validPrompt,
  pendingObligation,
  attemptFor,
} from '../plugin-host-task-diagnostics-helpers.js';

/** Build a strict reviewer-owned payload with no host provenance. */
function reviewerTaskResult(
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
    attestation: {
      toolObligationId: obligationId,
    },
  });
}

function setupHostStampedCycle() {
  const state = createSessionState();
  onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);
  const obligation = pendingObligation();
  const taskResult = reviewerTaskResult(obligation.obligationId);
  onTaskToolAfter(
    state,
    { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
    taskResult,
    LATER,
    { metadata: { sessionID: CHILD_SESSION_ID }, callID: 'call_provenance_001' },
  );
  return { state, obligation, attempts: [attemptFor(obligation, CHILD_SESSION_ID)] };
}

describe('F8: host-authoritative reviewer provenance', () => {
  it('stamps reviewedAt from the host invocation timestamp', () => {
    const { state, obligation, attempts } = setupHostStampedCycle();
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });

    expect(result.bindOutcome).toBe('bound');
    const raw = result.evidence?.capturedRawFindings as Record<string, unknown>;
    expect(raw.reviewedAt).toBe(LATER);
    expect(raw.reviewerClaimedAt).toBeUndefined();
  });

  it('does not persist a reviewer timestamp claim', () => {
    const { state, obligation, attempts } = setupHostStampedCycle();
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });
    const raw = result.evidence?.capturedRawFindings as Record<string, unknown>;
    expect(raw.reviewerClaimedAt).toBeUndefined();
  });

  it('stamps reviewedBy.sessionId from the resolved child session id', () => {
    const { state, obligation, attempts } = setupHostStampedCycle();
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });
    const raw = result.evidence?.capturedRawFindings as Record<string, unknown>;
    const reviewedBy = raw.reviewedBy as Record<string, unknown>;
    expect(reviewedBy.sessionId).toBe(CHILD_SESSION_ID);
  });

  it('builds the ENTIRE reviewedBy block host-authoritatively — no model fields leak through', () => {
    const { state, obligation, attempts } = setupHostStampedCycle();
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });
    const raw = result.evidence?.capturedRawFindings as Record<string, unknown>;
    const reviewedBy = raw.reviewedBy as Record<string, unknown>;
    expect(reviewedBy).toEqual({
      sessionId: CHILD_SESSION_ID,
      actorId: REVIEWER_SUBAGENT_TYPE,
      actorSource: 'unknown',
      actorAssurance: 'best_effort',
    });
  });

  it('does not persist a reviewer identity claim', () => {
    const { state, obligation, attempts } = setupHostStampedCycle();
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });
    const raw = result.evidence?.capturedRawFindings as Record<string, unknown>;
    expect(raw.reviewerClaimedBy).toBeUndefined();
  });

  it('rejects reviewer-owned provenance before host stamping', () => {
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
      attestation: {
        toolObligationId: obligation.obligationId,
      },
    });
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      taskResult,
      LATER,
      { metadata: { sessionID: CHILD_SESSION_ID }, callID: 'call_provenance_003' },
    );
    const attempts = [attemptFor(obligation)];
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });
    expect(result.bindOutcome).toBe('schema_invalid');
  });

  it('produces capturedRawFindings that still satisfy the Zod ReviewFindings schema', () => {
    const { state, obligation, attempts } = setupHostStampedCycle();
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });
    const raw = result.evidence?.capturedRawFindings;
    const parsed = ReviewFindings.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it('stamps canonical provenance when the reviewer does not claim it', () => {
    const state = createSessionState();
    onFlowGuardToolAfter(state, 'flowguard_plan', {}, modeAResponse(0, 1), NOW);
    const obligation = pendingObligation();
    const taskResult = reviewerTaskResult(obligation.obligationId);
    onTaskToolAfter(
      state,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      taskResult,
      LATER,
      { metadata: { sessionID: CHILD_SESSION_ID }, callID: 'call_provenance_002' },
    );
    const attempts = [attemptFor(obligation)];
    const result = buildHostTaskEvidence(state, SESSION_ID, LATER, {
      obligations: [obligation],
      invocations: [],
      attempts: attempts,
    });
    const raw = result.evidence?.capturedRawFindings as Record<string, unknown>;
    expect(raw.reviewedAt).toBe(LATER);
    expect(raw.reviewerClaimedAt).toBeUndefined();
    expect(raw.reviewerClaimedBy).toBeUndefined();
    expect(raw.reviewedBy).toEqual({
      sessionId: CHILD_SESSION_ID,
      actorId: REVIEWER_SUBAGENT_TYPE,
      actorSource: 'unknown',
      actorAssurance: 'best_effort',
    });
  });
});
