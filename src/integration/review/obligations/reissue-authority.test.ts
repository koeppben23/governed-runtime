/**
 * @module integration/review/reissue-authority.test
 * @description Transition-authority matrix for the transport-neutral
 *              dispatch-recovery re-arm.
 */
import { describe, expect, it } from 'vitest';
import { assuranceWith as fixtureAssuranceWith } from '../../../fixtures.js';
import { createReviewObligation } from './assurance.js';
import { createAttemptForExistingObligation, createReviewAttempt } from './attempt-lifecycle.js';
import { updateAttemptStatus } from './attempt-lifecycle.js';
import {
  hashCanonicalContentSubject,
  hashCanonicalReviewContent,
} from '../../../shared/review-subject.js';
import { countReviewAttempts } from '../../../state/review-continuation.js';
import { authorizeDispatchRearm } from './reissue-authority.js';
import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewDispatchRecord,
  ReviewMaterial,
  ReviewObligation,
} from '../../../state/evidence.js';

const NOW = '2026-08-12T00:00:00.000Z';

/** Consistent frozen material so the integrity gate passes for intact fixtures. */
const MATERIAL_CONTENT = 'frozen review material line 1\nline 2\n';
const MATERIAL_DIGEST = hashCanonicalReviewContent(MATERIAL_CONTENT);
const SUBJECT_DIGEST = hashCanonicalContentSubject(MATERIAL_DIGEST);

const FROZEN_MATERIAL: ReviewMaterial = {
  content: MATERIAL_CONTENT,
  materialDigest: MATERIAL_DIGEST,
  subjectDigest: SUBJECT_DIGEST,
};

function makeObligation(overrides: Partial<ReviewObligation> = {}): ReviewObligation {
  return {
    ...createReviewObligation({
      obligationType: 'review',
      reviewCycle: null,
      iteration: 1,
      planVersion: 1,
      now: NOW,
      subjectDigest: SUBJECT_DIGEST,
      reviewMaterial: FROZEN_MATERIAL,
      reviewSubject: {
        kind: 'content',
        source: { kind: 'inline', mediaType: 'text' },
        materialDigest: MATERIAL_DIGEST,
        subjectDigest: SUBJECT_DIGEST,
        lineCount: 2,
      },
      policySnapshot: { maxReviewerAttempts: 1 },
    }),
    ...overrides,
  };
}

function initialAttempt(obligation: ReviewObligation): ReviewAttempt {
  return createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    ordinal: 1,
    origin: { kind: 'initial' },
    repositoryDiscovery: { kind: 'not_applicable' },
    observationCapability: null,
    now: NOW,
  });
}

const assuranceWith = (
  obligation: ReviewObligation,
  attempts: ReviewAttempt[],
  dispatches: ReviewDispatchRecord[] = [],
): ReviewAssuranceState => fixtureAssuranceWith({ obligation, attempts, dispatches });

function dispatchRecord(
  obligation: ReviewObligation,
  attemptId: string,
  dispatchStatus: ReviewDispatchRecord['dispatchStatus'],
): ReviewDispatchRecord {
  return {
    dispatchId: '00000000-0000-4000-8000-0000000000d1',
    attemptId,
    obligationId: obligation.obligationId,
    hostCallId: 'child-session-1',
    canonicalPromptDigest: 'a'.repeat(64),
    dispatchAuthorizedAt: NOW,
    dispatchStatus,
  };
}

function createdWithDispatch(
  obligation: ReviewObligation,
  dispatchStatus: ReviewDispatchRecord['dispatchStatus'],
): { assurance: ReviewAssuranceState; attempt: ReviewAttempt } {
  const attempt = initialAttempt(obligation);
  return {
    assurance: assuranceWith(
      obligation,
      [attempt],
      [dispatchRecord(obligation, attempt.attemptId, dispatchStatus)],
    ),
    attempt,
  };
}

describe('authorizeDispatchRearm', () => {
  it('authorizes interrupted re-arm for a created attempt with an unresolved authorized dispatch', () => {
    const obligation = makeObligation();
    const { assurance, attempt } = createdWithDispatch(obligation, 'authorized');
    const result = authorizeDispatchRearm(assurance, attempt);
    expect(result).toEqual({
      kind: 'authorized',
      obligation,
      origin: {
        kind: 'dispatch_rearm',
        predecessorAttemptId: attempt.attemptId,
        triggerReason: 'interrupted',
      },
    });
  });

  it('authorizes spent re-arm for a created attempt whose only release concluded without evidence', () => {
    const obligation = makeObligation();
    const { assurance, attempt } = createdWithDispatch(obligation, 'outcome_unknown');
    const result = authorizeDispatchRearm(assurance, attempt);
    expect(result).toMatchObject({
      kind: 'authorized',
      origin: { kind: 'dispatch_rearm', triggerReason: 'spent' },
    });
  });

  it('blocks a created attempt that carries no released dispatch', () => {
    const obligation = makeObligation();
    const attempt = initialAttempt(obligation);
    const result = authorizeDispatchRearm(assuranceWith(obligation, [attempt]), attempt);
    expect(result).toMatchObject({ kind: 'blocked' });
    expect(result.kind === 'blocked' && result.reason).toContain('no released dispatch');
  });

  it('blocks a created attempt whose dispatch already completed', () => {
    const obligation = makeObligation();
    const { assurance, attempt } = createdWithDispatch(obligation, 'completed');
    const result = authorizeDispatchRearm(assurance, attempt);
    expect(result).toMatchObject({ kind: 'blocked' });
  });

  it.each(['rejected', 'stale', 'expired'] as const)(
    'blocks a %s attempt even without a dispatch',
    (status) => {
      const obligation = makeObligation();
      const created = initialAttempt(obligation);
      const assurance = updateAttemptStatus(
        assuranceWith(obligation, [created]),
        created.attemptId,
        status,
        NOW,
        status === 'rejected'
          ? { childSessionId: 'child-session-1', rejectionReason: 'schema_invalid' as const }
          : undefined,
      );
      const attempt = assurance.attempts[0]!;
      const result = authorizeDispatchRearm(assurance, attempt);
      expect(result).toMatchObject({ kind: 'blocked' });
    },
  );

  it('blocks re-arm on settled obligations', () => {
    const obligation = makeObligation({ status: 'fulfilled' });
    const attempt = initialAttempt(obligation);
    const result = authorizeDispatchRearm(assuranceWith(obligation, [attempt]), attempt);
    expect(result).toEqual({ kind: 'blocked', reason: 'rearm_obligation_settled' });
  });

  it('blocks re-arm when the obligation is missing', () => {
    const obligation = makeObligation();
    const attempt = initialAttempt(obligation);
    const assurance = assuranceWith(obligation, [attempt]);
    const orphaned = { ...attempt, obligationId: '00000000-0000-4000-8000-000000000000' };
    const result = authorizeDispatchRearm(assurance, orphaned);
    expect(result).toEqual({ kind: 'blocked', reason: 'rearm_obligation_not_found' });
  });

  it('exhausts the frozen budget: one existing re-arm blocks the next', () => {
    const obligation = makeObligation({ maxReviewerAttempts: 1 });
    const initial = initialAttempt(obligation);
    const rearmed = createAttemptForExistingObligation(
      assuranceWith(obligation, [initial]),
      obligation,
      undefined,
      NOW,
      {
        origin: {
          kind: 'dispatch_rearm',
          predecessorAttemptId: initial.attemptId,
          triggerReason: 'interrupted',
        },
        repositoryDiscovery: { kind: 'not_applicable' },
      },
    ).attempt;
    const result = authorizeDispatchRearm(assuranceWith(obligation, [initial, rearmed]), initial);
    expect(result).toMatchObject({ kind: 'blocked' });
    expect(result.kind === 'blocked' && result.reason).toContain('budget exhausted');
  });

  it('respects a frozen budget of zero even when a release was interrupted', () => {
    const obligation = makeObligation({ maxReviewerAttempts: 0 });
    const { assurance, attempt } = createdWithDispatch(obligation, 'authorized');
    const result = authorizeDispatchRearm(assurance, attempt);
    expect(result).toMatchObject({ kind: 'blocked' });
    expect(result.kind === 'blocked' && result.reason).toContain('budget exhausted');
  });
});

describe('countReviewAttempts', () => {
  it('counts only dispatch_rearm origins', () => {
    const obligation = makeObligation();
    const initial = initialAttempt(obligation);
    const rearmed = createAttemptForExistingObligation(
      assuranceWith(obligation, [initial]),
      obligation,
      undefined,
      NOW,
      {
        origin: {
          kind: 'dispatch_rearm',
          predecessorAttemptId: initial.attemptId,
          triggerReason: 'interrupted',
        },
        repositoryDiscovery: { kind: 'not_applicable' },
      },
    ).attempt;
    const assurance = assuranceWith(obligation, [initial, rearmed]);
    expect(countReviewAttempts(assurance, obligation.obligationId)).toBe(1);
  });
});
