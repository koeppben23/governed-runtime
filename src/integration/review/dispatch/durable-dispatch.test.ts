/**
 * @module integration/review/durable-dispatch.test
 * @description Blocker 3: durable dispatch authorization, abandonment, and
 * crash recovery. No reviewer evidence may be recorded without a prior
 * `authorized` dispatch record, and a crash after release must resolve as an
 * interrupted dispatch that re-arms a fresh attempt.
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionState } from '../../../state/schema.js';
import {
  hasReleasedDispatch,
  resolveReviewContinuation,
} from '../../../state/review-continuation.js';
import { makeState } from '../../../fixtures.js';
import {
  abandonReviewDispatchByHostCall,
  buildInterruptedDispatchRearm,
  persistAuthorizedReviewDispatch,
  type DispatchLedgerWriteDeps,
} from './durable-dispatch.js';
import { recordEvidenceOrBlockReuse } from '../evidence/reviewer-evidence-recorder.js';
import {
  artifactReviewSubjectScope,
  appendObligationWithAttempt,
  createReviewObligation,
  freezeReviewMaterial,
} from '../obligations/assurance.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';
import { hashFindings } from '../findings-hash.js';
import type { ReviewerSuccessResult } from '../types.js';

const NOW = '2026-05-10T12:00:00.000Z';
const CHILD = 'child-session-dispatch-1';
const PARENT = 'parent-session-dispatch-1';
const SESS_DIR = '/tmp/fg-durable-dispatch-test';
const PROMPT_DIGEST = 'b'.repeat(64);

function baseAssurance(obligationType: 'plan' | 'review' = 'plan') {
  const obligation = createReviewObligation({
    obligationType,
    reviewCycle: 1,
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'subject-digest-1',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'subject-digest-1'),
    reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'subject-digest-1'),
    ...(obligationType === 'plan' && {
      repositoryEvidenceFreeze: { kind: 'unavailable' as const, reason: 'repository_unavailable' },
    }),
  });
  const minted = appendObligationWithAttempt(ensureReviewAssurance(undefined), obligation, NOW);
  return {
    obligation,
    attempt: minted.assurance.attempts.find((attempt) => attempt.attemptId === minted.attemptId)!,
    assurance: minted.assurance,
  };
}

function writeDeps(stateRef: { current: SessionState }): DispatchLedgerWriteDeps {
  return {
    updateReviewAssurance: vi.fn(async (_sessDir, update) => {
      stateRef.current = update(stateRef.current, NOW);
    }),
  };
}

function persistAuthorizedSdkDispatch(
  deps: DispatchLedgerWriteDeps,
  sessDir: string,
  input: {
    readonly attemptId: string;
    readonly obligationId: string;
    readonly childSessionId: string;
    readonly canonicalPromptDigest: string;
    readonly authorizedAt: string;
  },
): Promise<void> {
  return persistAuthorizedReviewDispatch(deps, sessDir, {
    ...input,
    hostCallId: input.childSessionId,
  });
}

function abandonSdkDispatch(
  deps: DispatchLedgerWriteDeps,
  sessDir: string,
  childSessionId: string,
): Promise<void> {
  return abandonReviewDispatchByHostCall(deps, sessDir, childSessionId);
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

  it('BAD: a host call collision with a different attempt fails closed', async () => {
    const { obligation, attempt, assurance } = baseAssurance();
    const otherAttempt = {
      ...attempt,
      attemptId: '00000000-0000-4000-8000-0000000000a2',
    };
    const stateRef = {
      current: makeState('PLAN', {
        reviewAssurance: { ...assurance, attempts: [attempt, otherAttempt] },
      }),
    };
    const deps = writeDeps(stateRef);
    await persistAuthorizedSdkDispatch(deps, SESS_DIR, {
      attemptId: attempt.attemptId,
      obligationId: obligation.obligationId,
      childSessionId: CHILD,
      canonicalPromptDigest: PROMPT_DIGEST,
      authorizedAt: NOW,
    });

    await expect(
      persistAuthorizedSdkDispatch(deps, SESS_DIR, {
        attemptId: otherAttempt.attemptId,
        obligationId: obligation.obligationId,
        childSessionId: CHILD,
        canonicalPromptDigest: PROMPT_DIGEST,
        authorizedAt: NOW,
      }),
    ).rejects.toThrow(/different dispatch authorization/);
    expect(stateRef.current.reviewAssurance!.dispatches).toHaveLength(1);
    expect(stateRef.current.reviewAssurance!.dispatches[0]!.attemptId).toBe(attempt.attemptId);
  });

  it('BAD: a host call collision with a different obligation fails closed', async () => {
    const { obligation, attempt, assurance } = baseAssurance();
    const otherObligation = {
      ...obligation,
      obligationId: '00000000-0000-4000-8000-0000000000b2',
    };
    const otherAttempt = {
      ...attempt,
      attemptId: '00000000-0000-4000-8000-0000000000b3',
      obligationId: otherObligation.obligationId,
    };
    const stateRef = {
      current: makeState('PLAN', {
        reviewAssurance: {
          ...assurance,
          obligations: [obligation, otherObligation],
          attempts: [attempt, otherAttempt],
        },
      }),
    };
    const deps = writeDeps(stateRef);
    await persistAuthorizedSdkDispatch(deps, SESS_DIR, {
      attemptId: attempt.attemptId,
      obligationId: obligation.obligationId,
      childSessionId: CHILD,
      canonicalPromptDigest: PROMPT_DIGEST,
      authorizedAt: NOW,
    });

    await expect(
      persistAuthorizedSdkDispatch(deps, SESS_DIR, {
        attemptId: otherAttempt.attemptId,
        obligationId: otherObligation.obligationId,
        childSessionId: CHILD,
        canonicalPromptDigest: PROMPT_DIGEST,
        authorizedAt: NOW,
      }),
    ).rejects.toThrow(/different dispatch authorization/);
    expect(stateRef.current.reviewAssurance!.dispatches).toHaveLength(1);
    expect(stateRef.current.reviewAssurance!.dispatches[0]!.obligationId).toBe(
      obligation.obligationId,
    );
  });

  it('BAD: a host call collision with a different prompt digest fails closed', async () => {
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

    await expect(
      persistAuthorizedSdkDispatch(deps, SESS_DIR, {
        attemptId: attempt.attemptId,
        obligationId: obligation.obligationId,
        childSessionId: CHILD,
        canonicalPromptDigest: 'd'.repeat(64),
        authorizedAt: NOW,
      }),
    ).rejects.toThrow(/different dispatch authorization/);
    expect(stateRef.current.reviewAssurance!.dispatches).toHaveLength(1);
  });

  it('BAD: a resolved host call cannot be re-authorized', async () => {
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
    await abandonSdkDispatch(deps, SESS_DIR, CHILD);

    await expect(persistAuthorizedSdkDispatch(deps, SESS_DIR, input)).rejects.toThrow(
      /different dispatch authorization/,
    );
    expect(stateRef.current.reviewAssurance!.dispatches).toHaveLength(1);
    expect(stateRef.current.reviewAssurance!.dispatches[0]!.dispatchStatus).toBe('outcome_unknown');
  });
});

describe('abandonSdkDispatch and interrupted-dispatch recovery', () => {
  it('HAPPY: abandoning marks the entry outcome_unknown and keeps the attempt spent, not re-dispatchable', async () => {
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
    expect(hasReleasedDispatch(stateRef.current.reviewAssurance, attempt.attemptId)).toBe(true);
    expect(resolveReviewContinuation(stateRef.current.reviewAssurance, 'plan').kind).toBe(
      'interrupted_dispatch',
    );

    await abandonSdkDispatch(deps, SESS_DIR, CHILD);

    expect(stateRef.current.reviewAssurance!.dispatches[0]!.dispatchStatus).toBe('outcome_unknown');
    // A concluded host call leaves the attempt SPENT: it is still bindable but
    // must never be released again. Recovery is a durable re-arm that consumes
    // the shared reviewer-attempt budget — not a free retry of the same attempt.
    expect(hasReleasedDispatch(stateRef.current.reviewAssurance, attempt.attemptId)).toBe(true);
    expect(resolveReviewContinuation(stateRef.current.reviewAssurance, 'plan').kind).toBe(
      'interrupted_dispatch',
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
      kind: 'dispatch_rearm',
      predecessorAttemptId: attempt.attemptId,
      triggerReason: 'interrupted',
    });
    expect(rearmed.assurance!.dispatches[0]!.dispatchStatus).toBe('outcome_unknown');
  });

  it('BUDGET: each concluded host release consumes one reviewer attempt, not per command', async () => {
    const { obligation, attempt, assurance } = baseAssurance();
    const stateRef = { current: makeState('PLAN', { reviewAssurance: assurance }) };
    const deps = writeDeps(stateRef);

    // Attempt A released and concluded without evidence (spent).
    await persistAuthorizedSdkDispatch(deps, SESS_DIR, {
      attemptId: attempt.attemptId,
      obligationId: obligation.obligationId,
      childSessionId: CHILD,
      canonicalPromptDigest: PROMPT_DIGEST,
      authorizedAt: NOW,
    });
    await abandonSdkDispatch(deps, SESS_DIR, CHILD);

    // First command re-invocation re-arms a fresh attempt (budget slot 1/1).
    const first = buildInterruptedDispatchRearm(stateRef.current.reviewAssurance, attempt, NOW);
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.attempt.origin).toMatchObject({
      kind: 'dispatch_rearm',
      triggerReason: 'spent',
    });

    // The fresh attempt is released and concluded without evidence as well.
    stateRef.current = makeState('PLAN', { reviewAssurance: first.assurance });
    await persistAuthorizedSdkDispatch(deps, SESS_DIR, {
      attemptId: first.attempt.attemptId,
      obligationId: obligation.obligationId,
      childSessionId: 'child-session-dispatch-2',
      canonicalPromptDigest: PROMPT_DIGEST,
      authorizedAt: NOW,
    });
    await abandonSdkDispatch(deps, SESS_DIR, 'child-session-dispatch-2');
    expect(resolveReviewContinuation(stateRef.current.reviewAssurance, 'plan').kind).toBe(
      'interrupted_dispatch',
    );

    // Second re-arm must be refused: the frozen budget (maxReviewerAttempts=1)
    // is consumed by the first re-arm instead of resetting per command.
    const second = buildInterruptedDispatchRearm(
      stateRef.current.reviewAssurance,
      first.attempt,
      NOW,
    );
    expect(second.kind).toBe('blocked');
    if (second.kind !== 'blocked') return;
    expect(second.reason).toContain('budget exhausted');
  });
});

describe('recordEvidenceOrBlockReuse — durable dispatch gate', () => {
  function recordingParams(
    attemptId: string,
    obligationId: string,
    obligationType: 'plan' | 'review' = 'plan',
    overallVerdict: 'accept' | 'unable_to_review' = 'accept',
  ) {
    const findings = {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent',
      overallVerdict,
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
      obligationType,
      sessionId: PARENT,
      childSessionId: CHILD,
      hostCallId: CHILD,
      attemptId,
      promptHash: PROMPT_DIGEST,
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
      invocationMode: 'native_task_structured_followup',
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

  it('HAPPY: consumes unable peer-review evidence instead of marking its obligation fulfilled', async () => {
    const { obligation, attempt, assurance } = baseAssurance('review');
    const stateRef = { current: makeState('PEER_REVIEW', { reviewAssurance: assurance }) };
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
      recordingParams(attempt.attemptId, obligation.obligationId, 'review', 'unable_to_review'),
    );

    expect(result).toBe('fulfilled');
    const after = stateRef.current.reviewAssurance!;
    expect(after.obligations[0]).toMatchObject({ status: 'consumed', fulfilledAt: null });
    expect(after.invocations[0]?.consumedByObligationId).toBe(obligation.obligationId);
  });

  it('BAD: an out-of-scope finding never binds the attempt or fulfills the obligation', async () => {
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

    const params = recordingParams(attempt.attemptId, obligation.obligationId);
    const findings = params.reviewerResult.findings as Record<string, unknown>;
    findings.blockingIssues = [
      {
        severity: 'critical',
        category: 'correctness',
        message: 'Out-of-scope finding.',
        relation: {
          subjectAnchors: [
            {
              kind: 'artifact_section',
              artifactKind: 'plan',
              artifactDigest: 'other-artifact-digest',
              sectionPath: [{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }],
            },
          ],
          evidenceLocations: [],
        },
      },
    ];

    const result = await recordEvidenceOrBlockReuse(deps as never, SESS_DIR, params);

    expect(result).toMatchObject({
      ok: false,
      code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
    });
    const after = stateRef.current.reviewAssurance!;
    expect(after.attempts[0]).toMatchObject({ status: 'created' });
    expect(after.obligations[0]).toMatchObject({ status: 'pending' });
    expect(after.invocations).toHaveLength(0);
    expect(after.dispatches[0]).toMatchObject({ dispatchStatus: 'authorized' });
  });
});
