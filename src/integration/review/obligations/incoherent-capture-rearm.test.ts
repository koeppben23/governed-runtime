/**
 * @module integration/review/incoherent-capture-rearm.test
 * @description Bounded F12 incoherent-capture re-arm: authorization caps,
 *              exact persisted mutation, and fail-closed identity mismatches.
 */
import { describe, expect, it } from 'vitest';
import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewInvocationEvidence,
  ReviewObligation,
} from '../../../state/evidence.js';
import { ReviewAssuranceState as ReviewAssuranceStateSchema } from '../../../state/evidence.js';
import { hashText } from '../../../shared/hashing.js';
import { completedDispatchForInvocation } from '../../../state/evidence-test-constants.js';
import {
  artifactReviewSubjectScope,
  buildInvocationEvidence,
  createReviewObligation,
  freezeReviewMaterial,
} from './assurance.js';
import { hashFindings } from '../findings-hash.js';
import {
  authorizeIncoherentCaptureRearm,
  buildIncoherentCaptureRearm,
} from './incoherent-capture-rearm.js';

const REVIEWED_AT = '2026-01-01T00:00:00.000Z';
const BOUND_AT = '2026-01-01T00:00:01.000Z';
const F12_AT = '2026-01-01T00:00:02.000Z';
const A1_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_SESSION = 'ses_child';

const INCOHERENT_RAW_FINDINGS = {
  overallVerdict: 'accept',
  blockingIssues: [{ severity: 'major', category: 'correctness', message: 'contradiction' }],
};

function planObligation(maxReviewerAttempts = 3): ReviewObligation {
  const body = '## Approach\n\nBody';
  const digest = hashText(body);
  return createReviewObligation({
    obligationType: 'plan',
    iteration: 0,
    reviewCycle: 1,
    planVersion: 1,
    now: REVIEWED_AT,
    subjectDigest: digest,
    reviewMaterial: freezeReviewMaterial(body, digest),
    reviewSubjectScope: artifactReviewSubjectScope('plan', body, digest),
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
    policySnapshot: { maxReviewerAttempts },
  });
}

function boundAttempt(
  obligation: ReviewObligation,
  attemptId: string,
  ordinal: number,
  origin: ReviewAttempt['origin'] = { kind: 'initial' },
): ReviewAttempt {
  return {
    attemptId,
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    ordinal,
    childSessionId: CHILD_SESSION,
    status: 'bound',
    origin,
    repositoryDiscovery: { kind: 'not_applicable' },
    observations: [],
    createdAt: REVIEWED_AT,
    completedAt: BOUND_AT,
  };
}

function boundInvocation(
  obligation: ReviewObligation,
  attempt: ReviewAttempt,
  childSessionId: string = CHILD_SESSION,
): ReviewInvocationEvidence {
  return buildInvocationEvidence({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    mandateDigest: obligation.mandateDigest,
    criteriaVersion: obligation.criteriaVersion,
    parentSessionId: 'ses_parent',
    childSessionId,
    promptHash: 'b'.repeat(64),
    findingsHash: hashFindings(INCOHERENT_RAW_FINDINGS),
    invokedAt: REVIEWED_AT,
    fulfilledAt: BOUND_AT,
    attemptId: attempt.attemptId,
    capturedRawFindings: INCOHERENT_RAW_FINDINGS,
  });
}

interface F12Fixture {
  readonly assurance: ReviewAssuranceState;
  readonly obligation: ReviewObligation;
  readonly attempt: ReviewAttempt;
  readonly invocation: ReviewInvocationEvidence;
}

function f12Fixture(maxReviewerAttempts = 3): F12Fixture {
  const pending = planObligation(maxReviewerAttempts);
  const attempt = boundAttempt(pending, A1_ID, 1);
  const invocation = boundInvocation(pending, attempt);
  const obligation: ReviewObligation = {
    ...pending,
    status: 'fulfilled',
    invocationId: invocation.invocationId,
    fulfilledAt: BOUND_AT,
  };
  return {
    obligation,
    attempt,
    invocation,
    assurance: {
      assuranceSchemaVersion: 'review-assurance.v6',
      obligations: [obligation],
      invocations: [invocation],
      attempts: [attempt],
      dispatches: [completedDispatchForInvocation(invocation)],
    },
  };
}

/** Turn the freshly created re-arm attempt into the next bound F12 release. */
function bindNextF12(fixture: F12Fixture, attemptId: string): F12Fixture {
  const pendingAttempt = fixture.assurance.attempts.find(
    (candidate) => candidate.attemptId === attemptId,
  );
  if (!pendingAttempt) throw new Error(`missing attempt ${attemptId}`);
  const childSessionId = 'ses_child_rearm';
  const bound: ReviewAttempt = {
    ...pendingAttempt,
    status: 'bound',
    childSessionId,
    completedAt: BOUND_AT,
  };
  const invocation = boundInvocation(fixture.obligation, bound, childSessionId);
  const obligation: ReviewObligation = {
    ...fixture.obligation,
    status: 'fulfilled',
    invocationId: invocation.invocationId,
    fulfilledAt: BOUND_AT,
  };
  return {
    obligation,
    attempt: bound,
    invocation,
    assurance: {
      ...fixture.assurance,
      obligations: [obligation],
      invocations: [...fixture.assurance.invocations, invocation],
      attempts: fixture.assurance.attempts.map((candidate) =>
        candidate.attemptId === attemptId ? bound : candidate,
      ),
      dispatches: [...fixture.assurance.dispatches, completedDispatchForInvocation(invocation)],
    },
  };
}

describe('authorizeIncoherentCaptureRearm', () => {
  it('HAPPY: authorizes an exact bound F12 release within both budgets', () => {
    const { assurance } = f12Fixture();
    expect(ensureValid(assurance)).toBe(true);
    expect(
      authorizeIncoherentCaptureRearm({
        assurance,
        obligationId: assurance.obligations[0]!.obligationId,
        maxIncoherentReviewerCaptureRetries: 1,
        now: F12_AT,
      }),
    ).toEqual({ kind: 'authorized' });
  });

  it('blocks when the obligation is not fulfilled', () => {
    const fixture = f12Fixture();
    const pending: ReviewAssuranceState = {
      ...fixture.assurance,
      obligations: [{ ...fixture.obligation, status: 'pending' }],
    };
    expect(
      authorizeIncoherentCaptureRearm({
        assurance: pending,
        obligationId: fixture.obligation.obligationId,
        maxIncoherentReviewerCaptureRetries: 1,
        now: F12_AT,
      }),
    ).toEqual({ kind: 'blocked', reason: 'incoherent_rearm_obligation_not_fulfilled' });
  });

  it('blocks when the canonical invocation linkage is absent', () => {
    const fixture = f12Fixture();
    const unlinked: ReviewAssuranceState = {
      ...fixture.assurance,
      obligations: [{ ...fixture.obligation, invocationId: null }],
    };
    expect(
      authorizeIncoherentCaptureRearm({
        assurance: unlinked,
        obligationId: fixture.obligation.obligationId,
        maxIncoherentReviewerCaptureRetries: 1,
        now: F12_AT,
      }),
    ).toEqual({ kind: 'blocked', reason: 'incoherent_rearm_invocation_missing' });
  });

  it('blocks when the invocation attempt binding is missing', () => {
    const fixture = f12Fixture();
    const missingAttempt: ReviewAssuranceState = { ...fixture.assurance, attempts: [] };
    expect(
      authorizeIncoherentCaptureRearm({
        assurance: missingAttempt,
        obligationId: fixture.obligation.obligationId,
        maxIncoherentReviewerCaptureRetries: 1,
        now: F12_AT,
      }),
    ).toEqual({ kind: 'blocked', reason: 'incoherent_rearm_attempt_missing' });
  });

  it('blocks when the bound attempt is not bound', () => {
    const fixture = f12Fixture();
    const notBound: ReviewAssuranceState = {
      ...fixture.assurance,
      attempts: [{ ...fixture.attempt, status: 'created', completedAt: undefined }],
    };
    expect(
      authorizeIncoherentCaptureRearm({
        assurance: notBound,
        obligationId: fixture.obligation.obligationId,
        maxIncoherentReviewerCaptureRetries: 1,
        now: F12_AT,
      }),
    ).toEqual({ kind: 'blocked', reason: 'incoherent_rearm_attempt_not_bound' });
  });

  it('blocks when the invocation child session does not match the bound attempt', () => {
    const fixture = f12Fixture();
    const mismatched: ReviewAssuranceState = {
      ...fixture.assurance,
      invocations: [{ ...fixture.invocation, childSessionId: 'ses_other' }],
    };
    expect(
      authorizeIncoherentCaptureRearm({
        assurance: mismatched,
        obligationId: fixture.obligation.obligationId,
        maxIncoherentReviewerCaptureRetries: 1,
        now: F12_AT,
      }),
    ).toEqual({ kind: 'blocked', reason: 'incoherent_rearm_binding_mismatch' });
  });

  it('blocks an unknown obligation', () => {
    const { assurance } = f12Fixture();
    expect(
      authorizeIncoherentCaptureRearm({
        assurance,
        obligationId: '99999999-9999-4999-8999-999999999999',
        maxIncoherentReviewerCaptureRetries: 1,
        now: F12_AT,
      }),
    ).toEqual({ kind: 'blocked', reason: 'incoherent_rearm_obligation_not_found' });
  });
});

describe('buildIncoherentCaptureRearm mutation', () => {
  it('HAPPY: persists the exact F12 re-arm mutation', () => {
    const fixture = f12Fixture();
    const result = buildIncoherentCaptureRearm({
      assurance: fixture.assurance,
      obligationId: fixture.obligation.obligationId,
      maxIncoherentReviewerCaptureRetries: 1,
      now: F12_AT,
    });
    expect(result.kind).toBe('rearmed');
    if (result.kind !== 'rearmed') throw new TypeError('expected a re-armed result');

    expect(result.obligationId).toBe(fixture.obligation.obligationId);
    expect(ensureValid(result.assurance)).toBe(true);

    const rejected = result.assurance.attempts.find(
      (attempt) => attempt.attemptId === fixture.attempt.attemptId,
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      rejectionReason: 'consistency_invalid',
      completedAt: F12_AT,
    });
    expect(rejected?.childSessionId).toBe(fixture.attempt.childSessionId);

    expect(result.assurance.dispatches).toEqual(fixture.assurance.dispatches);
    expect(result.assurance.invocations).toEqual(fixture.assurance.invocations);

    const obligation = result.assurance.obligations[0]!;
    expect(obligation).toMatchObject({
      status: 'pending',
      invocationId: null,
      fulfilledAt: null,
      consumedAt: null,
      blockedCode: null,
    });

    expect(result.attempt).toMatchObject({
      obligationId: fixture.obligation.obligationId,
      status: 'created',
      ordinal: fixture.attempt.ordinal + 1,
      origin: {
        kind: 'dispatch_rearm',
        predecessorAttemptId: fixture.attempt.attemptId,
        triggerReason: 'spent',
      },
    });
    expect(result.attempt.childSessionId).toBeUndefined();
    expect(result.attempt.repositoryDiscovery).toEqual(fixture.attempt.repositoryDiscovery);
    expect(result.attempt.attemptId).not.toBe(fixture.attempt.attemptId);
  });

  it('never marks the completed predecessor dispatch outcome_unknown', () => {
    const fixture = f12Fixture();
    const result = buildIncoherentCaptureRearm({
      assurance: fixture.assurance,
      obligationId: fixture.obligation.obligationId,
      maxIncoherentReviewerCaptureRetries: 1,
      now: F12_AT,
    });
    if (result.kind !== 'rearmed') throw new TypeError('expected a re-armed result');
    expect(result.assurance.dispatches.map((record) => record.dispatchStatus)).toEqual([
      'completed',
    ]);
  });
});

describe('buildIncoherentCaptureRearm budgets', () => {
  it('CAP 1: allows exactly one retry, then blocks the second F12', () => {
    const first = f12Fixture();
    const firstRearm = buildIncoherentCaptureRearm({
      assurance: first.assurance,
      obligationId: first.obligation.obligationId,
      maxIncoherentReviewerCaptureRetries: 1,
      now: F12_AT,
    });
    expect(firstRearm.kind).toBe('rearmed');
    if (firstRearm.kind !== 'rearmed') throw new TypeError('expected a re-armed result');

    const second = bindNextF12(
      { ...first, assurance: firstRearm.assurance },
      firstRearm.attempt.attemptId,
    );
    expect(ensureValid(second.assurance)).toBe(true);

    const secondRearm = buildIncoherentCaptureRearm({
      assurance: second.assurance,
      obligationId: second.obligation.obligationId,
      maxIncoherentReviewerCaptureRetries: 1,
      now: F12_AT,
    });
    expect(secondRearm).toEqual({
      kind: 'blocked',
      reason: 'incoherent reviewer capture retry budget exhausted (1/1)',
    });
  });

  it('CAP 1: a limit of 0 blocks the first F12', () => {
    const fixture = f12Fixture();
    expect(
      buildIncoherentCaptureRearm({
        assurance: fixture.assurance,
        obligationId: fixture.obligation.obligationId,
        maxIncoherentReviewerCaptureRetries: 0,
        now: F12_AT,
      }),
    ).toEqual({
      kind: 'blocked',
      reason: 'incoherent reviewer capture retry budget exhausted (0/0)',
    });
  });

  it('CAP 2: maxReviewerAttempts 0 blocks the first F12', () => {
    const fixture = f12Fixture(0);
    expect(
      buildIncoherentCaptureRearm({
        assurance: fixture.assurance,
        obligationId: fixture.obligation.obligationId,
        maxIncoherentReviewerCaptureRetries: 1,
        now: F12_AT,
      }),
    ).toEqual({
      kind: 'blocked',
      reason: 'reviewer re-arm budget exhausted (0/0)',
    });
  });

  it('CAP 2: maxReviewerAttempts 1 still allows the single retry', () => {
    const fixture = f12Fixture(1);
    const result = buildIncoherentCaptureRearm({
      assurance: fixture.assurance,
      obligationId: fixture.obligation.obligationId,
      maxIncoherentReviewerCaptureRetries: 1,
      now: F12_AT,
    });
    expect(result.kind).toBe('rearmed');
  });

  it('does not mutate the input assurance on a blocked decision', () => {
    const fixture = f12Fixture(0);
    const before = JSON.stringify(fixture.assurance);
    buildIncoherentCaptureRearm({
      assurance: fixture.assurance,
      obligationId: fixture.obligation.obligationId,
      maxIncoherentReviewerCaptureRetries: 0,
      now: F12_AT,
    });
    expect(JSON.stringify(fixture.assurance)).toBe(before);
  });
});

function ensureValid(assurance: ReviewAssuranceState): boolean {
  const parsed = ReviewAssuranceStateSchema.safeParse(assurance);
  if (!parsed.success) {
    throw new TypeError(JSON.stringify(parsed.error.issues));
  }
  return true;
}
