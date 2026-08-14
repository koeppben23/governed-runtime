/**
 * @module integration/review/reissue-authority.test
 * @description Transition-authority matrix for output-repair reissues and
 *              task-lifecycle re-arms.
 */
import { describe, expect, it } from 'vitest';
import { createReviewObligation } from './assurance.js';
import { createAttemptForExistingObligation, createReviewAttempt } from './attempt-lifecycle.js';
import { updateAttemptStatus } from './attempt-lifecycle.js';
import {
  hashCanonicalContentSubject,
  hashCanonicalReviewContent,
} from '../../shared/review-subject.js';
import {
  authorizeOutputRepairReissue,
  authorizeTaskLifecycleRearm,
  countOutputRepairAttempts,
  latestAttemptForObligation,
} from './reissue-authority.js';
import type {
  ReviewAssuranceState,
  ReviewAttempt,
  ReviewMaterial,
  ReviewObligation,
} from '../../state/evidence.js';

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
      iteration: 1,
      planVersion: 1,
      now: NOW,
      subjectDigest: SUBJECT_DIGEST,
      reviewSubject: {
        kind: 'content',
        source: { kind: 'inline', mediaType: 'text' },
        materialDigest: MATERIAL_DIGEST,
        subjectDigest: SUBJECT_DIGEST,
        lineCount: 2,
      },
      policySnapshot: { maxReviewerOutputRepairAttempts: 1 },
    }),
    ...overrides,
  };
}

function initialAttempt(
  obligation: ReviewObligation,
  reviewMaterial: ReviewMaterial = FROZEN_MATERIAL,
): ReviewAttempt {
  return createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: obligation.obligationType,
    subjectDigest: obligation.subjectDigest,
    reviewMaterial,
    ordinal: 1,
    origin: { kind: 'initial' },
    repositoryDiscovery: { kind: 'not_applicable' },
    now: NOW,
  });
}

function assuranceWith(
  obligation: ReviewObligation,
  attempts: ReviewAttempt[],
): ReviewAssuranceState {
  return {
    assuranceSchemaVersion: 'review-assurance.v5',
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

  it('blocks when no attempt exists (missing persisted material is an integrity failure)', () => {
    const obligation = makeObligation();
    const result = authorizeOutputRepairReissue(assuranceWith(obligation, []), obligation);
    expect(result).toMatchObject({
      kind: 'integrity_blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
    });
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
        origin: {
          kind: 'output_repair',
          predecessorAttemptId: rejectedInitial.attemptId,
          triggerReason: 'schema_invalid',
        },
        repositoryDiscovery: { kind: 'not_applicable' } as const,
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

  it('blocks with REVIEW_MATERIAL_INTEGRITY_FAILED when the persisted material is tampered', () => {
    const obligation = makeObligation();
    const tampered: ReviewMaterial = {
      content: 'tampered bytes\n',
      materialDigest: MATERIAL_DIGEST,
      subjectDigest: SUBJECT_DIGEST,
    };
    const rejected = rejectedAttempt(obligation, 'schema_invalid');
    const tamperedAttempt: ReviewAttempt = { ...rejected, reviewMaterial: tampered };
    const result = authorizeOutputRepairReissue(
      assuranceWith(obligation, [tamperedAttempt]),
      obligation,
    );
    expect(result).toEqual({
      kind: 'integrity_blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: expect.stringContaining('material digest'),
    });
  });

  it('blocks with REVIEW_MATERIAL_INTEGRITY_FAILED when the persisted material is missing', () => {
    const obligation = makeObligation();
    const rejected = rejectedAttempt(obligation, 'schema_invalid');
    const withoutMaterial: ReviewAttempt = { ...rejected, reviewMaterial: undefined };
    const result = authorizeOutputRepairReissue(
      assuranceWith(obligation, [withoutMaterial]),
      obligation,
    );
    expect(result).toEqual({
      kind: 'integrity_blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: expect.stringContaining('missing'),
    });
  });

  it('integrity verification precedes reason and budget authority', () => {
    // Even a perfectly repairable rejection with budget left must not mint an
    // attempt when the immutable foundation is broken.
    const obligation = makeObligation();
    const tampered: ReviewMaterial = {
      content: 'other bytes\n',
      materialDigest: MATERIAL_DIGEST,
      subjectDigest: SUBJECT_DIGEST,
    };
    const rejected = rejectedAttempt(obligation, 'schema_invalid');
    const tamperedAttempt: ReviewAttempt = { ...rejected, reviewMaterial: tampered };
    const result = authorizeOutputRepairReissue(
      assuranceWith(obligation, [tamperedAttempt]),
      obligation,
    );
    expect(result).toMatchObject({
      kind: 'integrity_blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
    });
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
        origin: {
          kind: 'output_repair',
          predecessorAttemptId: initial.attemptId,
          triggerReason: 'schema_invalid',
        },
        repositoryDiscovery: { kind: 'not_applicable' } as const,
      },
    ).attempt;
    const rearmed = createAttemptForExistingObligation(
      assuranceWith(obligation, [initial, repair]),
      obligation,
      'child-session-2',
      NOW,
      {
        origin: {
          kind: 'task_rearm',
          predecessorAttemptId: repair.attemptId,
          triggerReason: 'rejected',
        },
        repositoryDiscovery: { kind: 'not_applicable' } as const,
      },
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
        origin: {
          kind: 'output_repair',
          predecessorAttemptId: first.attemptId,
          triggerReason: 'schema_invalid',
        },
        repositoryDiscovery: { kind: 'not_applicable' } as const,
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

describe('authorizeOutputRepairReissue — stall detection', () => {
  const FP_SAME = 'f'.repeat(64);
  const FP_OTHER = 'a'.repeat(64);

  /**
   * Build a real repair chain: attempt 1 rejected with a schema fingerprint,
   * then an authorized output_repair attempt rejected with (optionally) the
   * repaired fingerprint. Returns the settled assurance state.
   */
  function repairChain(fingerprintOfFirst: string, fingerprintOfRepair: string | null) {
    const obligation = makeObligation({ maxReviewerOutputRepairAttempts: 2 });
    let assurance = assuranceWith(obligation, [initialAttempt(obligation)]);
    const firstId = assurance.attempts[0]!.attemptId;
    assurance = updateAttemptStatus(assurance, firstId, 'rejected', NOW, {
      childSessionId: 'child-session-1',
      rejectionReason: 'schema_invalid',
      schemaErrorFingerprint: fingerprintOfFirst,
    });
    const repairMint = createAttemptForExistingObligation(assurance, obligation, undefined, NOW, {
      origin: {
        kind: 'output_repair',
        predecessorAttemptId: firstId,
        triggerReason: 'schema_invalid',
      },
      repositoryDiscovery: { kind: 'not_applicable' },
    });
    assurance = updateAttemptStatus(
      repairMint.assurance,
      repairMint.attempt.attemptId,
      'rejected',
      NOW,
      {
        childSessionId: 'child-session-2',
        rejectionReason: 'schema_invalid',
        ...(fingerprintOfRepair ? { schemaErrorFingerprint: fingerprintOfRepair } : {}),
      },
    );
    return { obligation, assurance };
  }

  it('blocks terminally when the targeted repair reproduced the identical error set', () => {
    const { obligation, assurance } = repairChain(FP_SAME, FP_SAME);
    const result = authorizeOutputRepairReissue(assurance, obligation);
    expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEWER_OUTPUT_REPAIR_STALLED' });
  });

  it('keeps the budget path when the repaired error set differs', () => {
    const { obligation, assurance } = repairChain(FP_SAME, FP_OTHER);
    const result = authorizeOutputRepairReissue(assurance, obligation);
    expect(result).toMatchObject({ kind: 'authorized', triggerReason: 'schema_invalid' });
  });

  it('fails safe without fingerprints (budget semantics apply)', () => {
    const obligation = makeObligation({ maxReviewerOutputRepairAttempts: 1 });
    let assurance = assuranceWith(obligation, [initialAttempt(obligation)]);
    const firstId = assurance.attempts[0]!.attemptId;
    assurance = updateAttemptStatus(assurance, firstId, 'rejected', NOW, {
      childSessionId: 'child-session-1',
      rejectionReason: 'schema_invalid',
    });
    const repairMint = createAttemptForExistingObligation(assurance, obligation, undefined, NOW, {
      origin: {
        kind: 'output_repair',
        predecessorAttemptId: firstId,
        triggerReason: 'schema_invalid',
      },
      repositoryDiscovery: { kind: 'not_applicable' },
    });
    assurance = updateAttemptStatus(
      repairMint.assurance,
      repairMint.attempt.attemptId,
      'rejected',
      NOW,
      { childSessionId: 'child-session-2', rejectionReason: 'schema_invalid' },
    );
    const result = authorizeOutputRepairReissue(assurance, obligation);
    expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEWER_OUTPUT_RETRY_EXHAUSTED' });
  });
});
