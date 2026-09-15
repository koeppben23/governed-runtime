/**
 * @module integration/review/durable-dispatch.test
 * @description Blocker 3: durable dispatch authorization, abandonment, and
 * crash recovery. No reviewer evidence may be recorded without a prior
 * `authorized` dispatch record, and a crash after release must resolve as an
 * interrupted dispatch that re-arms a fresh attempt.
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionState } from '../../state/schema.js';
import {
  hasUnresolvedDispatch,
  resolveReviewContinuation,
} from '../../state/review-continuation.js';
import { makeState } from '../../fixtures.js';
import {
  abandonSdkDispatch,
  buildInterruptedDispatchRearm,
  persistAuthorizedSdkDispatch,
  type DispatchLedgerWriteDeps,
} from '../durable-dispatch.js';
import { recordEvidenceOrBlockReuse } from './sdk-evidence-recorder.js';
import {
  artifactReviewSubjectScope,
  createAttemptForExistingObligation,
  createReviewObligation,
  ensureReviewAssurance,
  freezeReviewMaterial,
  hashFindings,
  hashText,
} from './assurance.js';
import type { ReviewerSuccessResult } from './orchestrator.js';

const NOW = '2026-05-10T12:00:00.000Z';
const CHILD = 'child-session-dispatch-1';
const PARENT = 'parent-session-dispatch-1';
const SESS_DIR = '/tmp/fg-durable-dispatch-test';
const PROMPT_DIGEST = 'b'.repeat(64);

function baseAssurance() {
  const obligation = createReviewObligation({
    obligationType: 'plan',
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'subject-digest-1',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'subject-digest-1'),
    reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'subject-digest-1'),
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
  });
  const withObligation = {
    ...ensureReviewAssurance(undefined),
    obligations: [obligation],
  };
  const minted = createAttemptForExistingObligation(withObligation, obligation, undefined, NOW, {
    origin: { kind: 'initial' },
    repositoryDiscovery: { kind: 'not_applicable' },
  });
  return { obligation, attempt: minted.attempt, assurance: minted.assurance };
}

function writeDeps(stateRef: { current: SessionState }): DispatchLedgerWriteDeps {
  return {
    updateReviewAssurance: vi.fn(async (_sessDir, update) => {
      stateRef.current = update(stateRef.current, NOW);
    }),
  };
}

describe('persistAuthorizedSdkDispatch', () => {
  it('HAPPY: appends an authorized durable dispatch for the created attempt', async () => {
    const { obligation, attempt, assurance } = baseAssurance();
    const stateRef = { current: makeState('PLAN', { reviewAssurance: assurance }) };
    const deps = writeDeps(stateRef);

    await persistAuthorizedSdkDispatch(deps, SESS_DIR, {
      attemptId: attempt.attemptId,
      obligationId: obligation.obligationId,
      childSessionId: CHILD,
      canonicalPromptDigest: PROMPT_DIGEST,
      authorizedAt: NOW,
    });

    const dispatches = stateRef.current.reviewAssurance!.dispatches;
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      attemptId: attempt.attemptId,
      obligationId: obligation.obligationId,
      hostCallId: CHILD,
      canonicalPromptDigest: PROMPT_DIGEST,
      dispatchAuthorizedAt: NOW,
      dispatchStatus: 'authorized',
    });
    expect(SessionState.safeParse(stateRef.current).success).toBe(true);
  });

  it('BAD: refuses to authorize without a created, unbound attempt', async () => {
    const { obligation, attempt, assurance } = baseAssurance();
    const boundAttempt = { ...attempt, status: 'bound' as const, childSessionId: 'other-child' };
    const stateRef = {
      current: makeState('PLAN', {
        reviewAssurance: { ...assurance, attempts: [boundAttempt] },
      }),
    };
    const deps = writeDeps(stateRef);

    await expect(
      persistAuthorizedSdkDispatch(deps, SESS_DIR, {
        attemptId: attempt.attemptId,
        obligationId: obligation.obligationId,
        childSessionId: CHILD,
        canonicalPromptDigest: PROMPT_DIGEST,
        authorizedAt: NOW,
      }),
    ).rejects.toThrow(/dispatch/);
    expect(stateRef.current.reviewAssurance!.dispatches).toHaveLength(0);
  });

  it('BAD: refuses to authorize a settled obligation', async () => {
    const { obligation, attempt, assurance } = baseAssurance();
    const consumedObligation = { ...obligation, status: 'consumed' as const, consumedAt: NOW };
    const stateRef = {
      current: makeState('PLAN', {
        reviewAssurance: { ...assurance, obligations: [consumedObligation] },
      }),
    };
    const deps = writeDeps(stateRef);

    await expect(
      persistAuthorizedSdkDispatch(deps, SESS_DIR, {
        attemptId: attempt.attemptId,
        obligationId: obligation.obligationId,
        childSessionId: CHILD,
        canonicalPromptDigest: PROMPT_DIGEST,
        authorizedAt: NOW,
      }),
    ).rejects.toThrow(/dispatch/);
    expect(stateRef.current.reviewAssurance!.dispatches).toHaveLength(0);
  });

  it('EDGE: is idempotent for the exact same host call', async () => {
    const { obligation, attempt, assurance } = baseAssurance();
    const stateRef = { current: makeState('PLAN', { reviewAssurance: assurance }) };
    const deps = writeDeps(stateRef);
    const input = {
      attemptId: attempt.attemptId,
      obligationId: obligation.obligationId,
      childSessionId: CHILD,
      canonicalPromptDigest: PROMPT_DIGEST,
      authorizedAt: NOW,
    };

    await persistAuthorizedSdkDispatch(deps, SESS_DIR, input);
    await persistAuthorizedSdkDispatch(deps, SESS_DIR, input);

    expect(stateRef.current.reviewAssurance!.dispatches).toHaveLength(1);
  });
});

describe('abandonSdkDispatch and interrupted-dispatch recovery', () => {
  it('HAPPY: abandoning marks the entry outcome_unknown and clears the interrupted state', async () => {
    const { obligation, attempt, assurance } = baseAssurance();
    const stateRef = { current: makeState('PLAN', { reviewAssurance: assurance }) };
    const deps = writeDeps(stateRef);
    await persistAuthorizedSdkDispatch(deps, SESS_DIR, {
      attemptId: attempt.attemptId,
      obligationId: obligation.obligationId,
      childSessionId: CHILD,
      canonicalPromptDigest: PROMPT_DIGEST,
      authorizedAt: NOW,
    });
    expect(hasUnresolvedDispatch(stateRef.current.reviewAssurance, attempt.attemptId)).toBe(true);
    expect(resolveReviewContinuation(stateRef.current.reviewAssurance, 'plan').kind).toBe(
      'interrupted_dispatch',
    );

    await abandonSdkDispatch(deps, SESS_DIR, CHILD);

    expect(stateRef.current.reviewAssurance!.dispatches[0]!.dispatchStatus).toBe('outcome_unknown');
    expect(hasUnresolvedDispatch(stateRef.current.reviewAssurance, attempt.attemptId)).toBe(false);
    expect(resolveReviewContinuation(stateRef.current.reviewAssurance, 'plan').kind).toBe(
      'awaiting_task',
    );
  });

  it('RECOVERY: an unresolved authorized dispatch re-arms a fresh attempt on the same obligation', async () => {
    const { obligation, attempt, assurance } = baseAssurance();
    const stateRef = { current: makeState('PLAN', { reviewAssurance: assurance }) };
    const deps = writeDeps(stateRef);
    await persistAuthorizedSdkDispatch(deps, SESS_DIR, {
      attemptId: attempt.attemptId,
      obligationId: obligation.obligationId,
      childSessionId: CHILD,
      canonicalPromptDigest: PROMPT_DIGEST,
      authorizedAt: NOW,
    });

    const continuation = resolveReviewContinuation(stateRef.current.reviewAssurance, 'plan');
    expect(continuation.kind).toBe('interrupted_dispatch');

    const rearmed = buildInterruptedDispatchRearm(stateRef.current.reviewAssurance, attempt, NOW);
    expect(rearmed.kind).toBe('ok');
    if (rearmed.kind !== 'ok') return;

    const attempts = rearmed.assurance!.attempts;
    expect(attempts.find((a) => a.attemptId === attempt.attemptId)?.status).toBe('stale');
    expect(rearmed.attempt.obligationId).toBe(obligation.obligationId);
    expect(rearmed.attempt.origin).toMatchObject({
      kind: 'task_rearm',
      predecessorAttemptId: attempt.attemptId,
      triggerReason: 'interrupted',
    });
    expect(rearmed.assurance!.dispatches[0]!.dispatchStatus).toBe('outcome_unknown');
  });
});

describe('recordEvidenceOrBlockReuse — durable dispatch gate', () => {
  function recordingParams(attemptId: string, obligationId: string) {
    const findings = {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict: 'accept',
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      challenges: [],
      reviewedBy: { sessionId: CHILD },
      reviewedAt: NOW,
    };
    return {
      obligationId,
      obligationType: 'plan' as const,
      sessionId: PARENT,
      childSessionId: CHILD,
      hostCallId: CHILD,
      attemptId,
      promptHash: hashText('prompt'),
      findingsHash: hashFindings(findings),
      invokedAt: NOW,
      fulfilledAt: NOW,
      reviewerResult: {
        sessionId: CHILD,
        rawResponse: JSON.stringify(findings),
        findings,
        reviewOutputMode: 'structured_output' as const,
        structuredOutputUsed: true,
        reviewAssuranceLevel: 'structured_high' as const,
      } satisfies ReviewerSuccessResult,
    };
  }

  it('BAD: records nothing without a prior authorized dispatch', async () => {
    const { obligation, attempt, assurance } = baseAssurance();
    const stateRef = { current: makeState('PLAN', { reviewAssurance: assurance }) };
    const deps = writeDeps(stateRef);

    const result = await recordEvidenceOrBlockReuse(
      deps as never,
      SESS_DIR,
      recordingParams(attempt.attemptId, obligation.obligationId),
    );

    expect(result).toBe('lineage_unavailable');
    const after = stateRef.current.reviewAssurance!;
    expect(after.invocations).toHaveLength(0);
    expect(after.attempts[0]!.status).toBe('created');
    expect(after.obligations[0]!.status).toBe('pending');
  });

  it('HAPPY: completes the exact dispatch atomically with attempt binding, invocation, and fulfillment', async () => {
    const { obligation, attempt, assurance } = baseAssurance();
    const stateRef = { current: makeState('PLAN', { reviewAssurance: assurance }) };
    const deps = writeDeps(stateRef);
    await persistAuthorizedSdkDispatch(deps, SESS_DIR, {
      attemptId: attempt.attemptId,
      obligationId: obligation.obligationId,
      childSessionId: CHILD,
      canonicalPromptDigest: PROMPT_DIGEST,
      authorizedAt: NOW,
    });

    const result = await recordEvidenceOrBlockReuse(
      deps as never,
      SESS_DIR,
      recordingParams(attempt.attemptId, obligation.obligationId),
    );

    expect(result).toBe('fulfilled');
    const after = stateRef.current.reviewAssurance!;
    expect(after.attempts[0]).toMatchObject({ status: 'bound', childSessionId: CHILD });
    expect(after.invocations).toHaveLength(1);
    expect(after.invocations[0]).toMatchObject({
      childSessionId: CHILD,
      attemptId: attempt.attemptId,
      invocationMode: 'sdk_session_prompt',
    });
    expect(after.obligations[0]).toMatchObject({
      status: 'fulfilled',
      invocationId: after.invocations[0]!.invocationId,
    });
    expect(after.dispatches[0]).toMatchObject({
      hostCallId: CHILD,
      dispatchStatus: 'completed',
      completedAt: NOW,
    });
    expect(SessionState.safeParse(stateRef.current).success).toBe(true);
  });
});
