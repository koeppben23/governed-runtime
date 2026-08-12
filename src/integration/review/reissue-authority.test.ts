/**
 * @module integration/review/reissue-authority.test
 * @description Transition-authority matrix for output-repair reissues and
 *              task-lifecycle re-arms.
 */
import { describe, expect, it } from 'vitest';
import { createReviewObligation, emptyReviewAssurance } from './assurance.js';
import { createAttemptForExistingObligation } from './attempt-lifecycle.js';
import { updateAttemptStatus } from './attempt-lifecycle.js';
import {
  authorizeOutputRepairReissue,
  authorizeTaskLifecycleRearm,
  countOutputRepairAttempts,
  latestAttemptForObligation,
} from './reissue-authority.js';
import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewObligation,
} from '../../state/evidence.js';

const NOW = '2026-08-12T00:00:00.000Z';

function makeObligation(overrides: Partial<ReviewObligation> = {}): ReviewObligation {
  return {
    ...createReviewObligation({
      obligationType: 'review',
      iteration: 1,
      planVersion: 1,
      now: NOW,
      subjectDigest: 'subject-digest',
      reviewSubject: {
        kind: 'content',
        source: { kind: 'inline', mediaType: 'text' },
        materialDigest: 'sha256:' + 'a'.repeat(64),
        subjectDigest: 'subject-digest',
        lineCount: 10,
      },
      policySnapshot: { maxReviewerOutputRepairAttempts: 1 },
    }),
    ...overrides,
  };
}

function initialAttempt(obligation: ReviewObligation): ReviewAttempt {
  return createAttemptForExistingObligation(emptyReviewAssurance(), obligation, undefined, NOW, {
    kind: 'initial',
  }).attempt;
}

function assuranceWith(
  obligation: ReviewObligation,
  attempts: ReviewAttempt[],
): ReviewAssuranceState {
  return {
    assuranceSchemaVersion: 'review-assurance.v2',
    obligations: [obligation],
    invocations: [],
    attempts,
  };
}

function rejectedAttempt(
  obligation: ReviewObligation,
  rejectionReason: ReviewAttempt['rejectionReason'],
  childSessionId = 'child-session-1',
): ReviewAttempt {
  const created = initialAttempt(obligation);
  return updateAttemptStatus(
    assuranceWith(obligation, [created]),
    created.attemptId,
    'rejected',
    NOW,
    { childSessionId, rejectionReason },
  ).attempts[0]!;
}

describe('authorizeOutputRepairReissue', () => {
  it('returns the open attempt when a bindable attempt exists (no minting)', () => {
    const obligation = makeObligation();
    const attempt = initialAttempt(obligation);
    const assurance = assuranceWith(obligation, [attempt]);
    const result = authorizeOutputRepairReissue(assurance, obligation);
    expect(result).toEqual({ kind: 'bindable_exists', attemptId: attempt.attemptId });
    expect(assurance.attempts).toHaveLength(1);
  });

  it('authorizes exactly one output_repair after a repairable rejection', () => {
    const obligation = makeObligation();
    const rejected = rejectedAttempt(obligation, 'schema_invalid');
    const result = authorizeOutputRepairReissue(assuranceWith(obligation, [rejected]), obligation);
    expect(result).toEqual({
      kind: 'authorized',
      predecessorAttemptId: rejected.attemptId,
      triggerReason: 'schema_invalid',
    });
  });

  it('blocks governance rejections (scope_invalid)', () => {
    const obligation = makeObligation();
    const rejected = rejectedAttempt(obligation, 'scope_invalid');
    const result = authorizeOutputRepairReissue(assuranceWith(obligation, [rejected]), obligation);
    expect(result).toMatchObject({
      kind: 'blocked',
      code: 'REVIEW_REPAIR_UNAVAILABLE',
    });
  });

  it('blocks semantic consistency rejections', () => {
    const obligation = makeObligation();
    const rejected = rejectedAttempt(obligation, 'consistency_invalid');
    const result = authorizeOutputRepairReissue(assuranceWith(obligation, [rejected]), obligation);
    expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEW_REPAIR_UNAVAILABLE' });
  });

  it('blocks material-integrity and subject rejections', () => {
    const obligation = makeObligation();
    for (const reason of ['material_integrity_failed', 'subject_mismatch'] as const) {
      const rejected = rejectedAttempt(obligation, reason);
      const result = authorizeOutputRepairReissue(
        assuranceWith(obligation, [rejected]),
        obligation,
      );
      expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEW_REPAIR_UNAVAILABLE' });
    }
  });

  it('blocks execution rejections', () => {
    const obligation = makeObligation();
    for (const reason of ['reviewer_unavailable', 'task_failed'] as const) {
      const rejected = rejectedAttempt(obligation, reason);
      const result = authorizeOutputRepairReissue(
        assuranceWith(obligation, [rejected]),
        obligation,
      );
      expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEW_REPAIR_UNAVAILABLE' });
    }
  });

  it('blocks a rejected attempt without a structured rejection reason', () => {
    const obligation = makeObligation();
    const rejected = rejectedAttempt(obligation, undefined);
    const result = authorizeOutputRepairReissue(assuranceWith(obligation, [rejected]), obligation);
    expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEW_REPAIR_UNAVAILABLE' });
    expect((result as { reason?: string }).reason).toContain(
      'without a structured rejection reason',
    );
  });

  it('blocks a non-rejected latest attempt (created with child session)', () => {
    const obligation = makeObligation();
    const created = initialAttempt(obligation);
    const correlated = updateAttemptStatus(
      assuranceWith(obligation, [created]),
      created.attemptId,
      'created',
      NOW,
      { childSessionId: 'child-session-1' },
    ).attempts[0]!;
    const result = authorizeOutputRepairReissue(
      assuranceWith(obligation, [correlated]),
      obligation,
    );
    expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEW_REPAIR_UNAVAILABLE' });
  });

  it('blocks when no attempt exists', () => {
    const obligation = makeObligation();
    const result = authorizeOutputRepairReissue(assuranceWith(obligation, []), obligation);
    expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEW_REPAIR_UNAVAILABLE' });
  });

  it('blocks non-pending obligations', () => {
    const obligation = makeObligation({ status: 'fulfilled' });
    const attempt = initialAttempt(obligation);
    const result = authorizeOutputRepairReissue(assuranceWith(obligation, [attempt]), obligation);
    expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEW_REPAIR_UNAVAILABLE' });
  });

  it('exhausts the frozen budget: repair #1 rejected → RETRY_EXHAUSTED', () => {
    const obligation = makeObligation({ maxReviewerOutputRepairAttempts: 1 });
    const initial = initialAttempt(obligation);
    const rejectedInitial = updateAttemptStatus(
      assuranceWith(obligation, [initial]),
      initial.attemptId,
      'rejected',
      NOW,
      { childSessionId: 'child-session-1', rejectionReason: 'schema_invalid' },
    ).attempts[0]!;
    const repair = createAttemptForExistingObligation(
      assuranceWith(obligation, [rejectedInitial]),
      obligation,
      undefined,
      NOW,
      {
        kind: 'output_repair',
        predecessorAttemptId: rejectedInitial.attemptId,
        triggerReason: 'schema_invalid',
      },
    ).attempt;
    const rejectedRepair = updateAttemptStatus(
      assuranceWith(obligation, [rejectedInitial, repair]),
      repair.attemptId,
      'rejected',
      NOW,
      { childSessionId: 'child-session-2', rejectionReason: 'schema_invalid' },
    ).attempts[1]!;
    const result = authorizeOutputRepairReissue(
      assuranceWith(obligation, [rejectedInitial, rejectedRepair]),
      obligation,
    );
    expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEWER_OUTPUT_RETRY_EXHAUSTED' });
  });

  it('frozen budget is respected even when live policy would allow more', () => {
    // Budget frozen at creation (0): a repairable rejection must not reissue.
    const obligation = makeObligation({ maxReviewerOutputRepairAttempts: 0 });
    const rejected = rejectedAttempt(obligation, 'schema_invalid');
    const result = authorizeOutputRepairReissue(assuranceWith(obligation, [rejected]), obligation);
    expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEWER_OUTPUT_RETRY_EXHAUSTED' });
  });

  it('countOutputRepairAttempts counts only output_repair origins', () => {
    const obligation = makeObligation();
    const initial = initialAttempt(obligation);
    const repair = createAttemptForExistingObligation(
      assuranceWith(obligation, [initial]),
      obligation,
      undefined,
      NOW,
      {
        kind: 'output_repair',
        predecessorAttemptId: initial.attemptId,
        triggerReason: 'schema_invalid',
      },
    ).attempt;
    const rearmed = createAttemptForExistingObligation(
      assuranceWith(obligation, [initial, repair]),
      obligation,
      'child-session-2',
      NOW,
      { kind: 'task_rearm', predecessorAttemptId: repair.attemptId, triggerReason: 'rejected' },
    ).attempt;
    const assurance = assuranceWith(obligation, [initial, repair, rearmed]);
    expect(countOutputRepairAttempts(assurance, obligation.obligationId)).toBe(1);
  });

  it('latestAttemptForObligation returns the highest ordinal', () => {
    const obligation = makeObligation();
    const first = initialAttempt(obligation);
    const second = createAttemptForExistingObligation(
      assuranceWith(obligation, [first]),
      obligation,
      undefined,
      NOW,
      {
        kind: 'output_repair',
        predecessorAttemptId: first.attemptId,
        triggerReason: 'schema_invalid',
      },
    ).attempt;
    const latest = latestAttemptForObligation(
      assuranceWith(obligation, [first, second]),
      obligation.obligationId,
    );
    expect(latest?.attemptId).toBe(second.attemptId);
  });
});

describe('authorizeTaskLifecycleRearm', () => {
  it('authorizes re-arm of an interrupted created attempt', () => {
    const obligation = makeObligation();
    const interrupted = updateAttemptStatus(
      assuranceWith(obligation, [initialAttempt(obligation)]),
      initialAttempt(obligation).attemptId,
      'created',
      NOW,
      { childSessionId: 'child-session-1' },
    ).attempts[0]!;
    const assurance = assuranceWith(obligation, [interrupted]);
    const result = authorizeTaskLifecycleRearm(assurance, interrupted);
    expect(result).toEqual({
      kind: 'authorized',
      obligation,
      origin: {
        kind: 'task_rearm',
        predecessorAttemptId: interrupted.attemptId,
        triggerReason: 'interrupted',
      },
    });
  });

  it('authorizes re-arm after a rejected attempt', () => {
    const obligation = makeObligation();
    const rejected = rejectedAttempt(obligation, 'schema_invalid');
    const result = authorizeTaskLifecycleRearm(assuranceWith(obligation, [rejected]), rejected);
    expect(result).toMatchObject({
      kind: 'authorized',
      origin: { kind: 'task_rearm', triggerReason: 'rejected' },
    });
  });

  it('blocks re-arm on settled obligations', () => {
    const obligation = makeObligation({ status: 'fulfilled' });
    const attempt = initialAttempt(obligation);
    const result = authorizeTaskLifecycleRearm(assuranceWith(obligation, [attempt]), attempt);
    expect(result).toEqual({ kind: 'blocked', reason: 'rearm_obligation_settled' });
  });

  it('blocks re-arm when the obligation is missing', () => {
    const obligation = makeObligation();
    const attempt = initialAttempt(obligation);
    const assurance = assuranceWith(obligation, [attempt]);
    const orphaned = { ...attempt, obligationId: '00000000-0000-4000-8000-000000000000' };
    const result = authorizeTaskLifecycleRearm(assurance, orphaned);
    expect(result).toEqual({ kind: 'blocked', reason: 'rearm_obligation_not_found' });
  });
});
