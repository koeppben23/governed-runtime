/**
 * @module integration/tools/review-tool/frozen-continuation.test
 * @description Contract: the frozen review subject is persisted state, not a
 * value that gets re-derived on every follow-up call.
 *
 * Re-deriving it from mutable sources (git refs, gh CLI, diff parsing) created a
 * second authority over immutable data: a continuation could fail outright, or
 * silently disagree with the subject the reviewer actually assessed.
 *
 * @test-policy HAPPY, BAD, EDGE — reuse, integrity failure, drift, scope limits.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveFrozenContinuationContent,
  assertFrozenSubjectUnchanged,
} from './frozen-continuation.js';
import { makeState } from '../../../fixtures.js';
import type { SessionState } from '../../../state/schema.js';
import type { ReviewObligation } from '../../../state/evidence.js';
import {
  hashCanonicalContentSubject,
  hashCanonicalReviewContent,
} from '../../../shared/review-subject.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from '../../review/assurance.js';

const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-05-06T12:00:00.000Z';
const MATERIAL = 'frozen review material';
const MATERIAL_DIGEST = hashCanonicalReviewContent(MATERIAL);
const SUBJECT_DIGEST = hashCanonicalContentSubject(MATERIAL_DIGEST);

function obligation(): ReviewObligation {
  return {
    obligationId: OBLIGATION_ID,
    obligationType: 'review',
    subjectDigest: SUBJECT_DIGEST,
    iteration: 1,
    planVersion: 1,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    mandateDigest: REVIEW_MANDATE_DIGEST,
    createdAt: NOW,
    pluginHandshakeAt: null,
    status: 'pending',
    invocationId: null,
    blockedCode: null,
    fulfilledAt: null,
    consumedAt: null,
    reviewSubjectScope: { kind: 'content', subjectDigest: SUBJECT_DIGEST, lineCount: 1 },
    reviewSubject: {
      kind: 'content',
      source: { kind: 'inline', mediaType: 'text' },
      materialDigest: MATERIAL_DIGEST,
      subjectDigest: SUBJECT_DIGEST,
      lineCount: 1,
    },
  } as ReviewObligation;
}

function stateWithMaterial(material: { content: string; materialDigest: string } | undefined) {
  return makeState('REVIEW', {
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v2' as const,
      obligations: [obligation()],
      invocations: [],
      attempts: [
        {
          attemptId: '22222222-2222-4222-8222-222222222222',
          obligationId: OBLIGATION_ID,
          obligationType: 'review' as const,
          subjectDigest: SUBJECT_DIGEST,
          ...(material ? { reviewMaterial: material } : {}),
          ordinal: 1,
          status: 'rejected' as const,
          origin: { kind: 'initial' } as const,
          createdAt: NOW,
        },
      ],
    },
  }) as SessionState;
}

const VERDICT_CONTINUATION = {
  policy: 'host_task_required',
  args: {
    branch: 'feature-x',
    reviewObligationId: OBLIGATION_ID,
    reviewVerdict: 'accept' as const,
  },
};

describe('resolveFrozenContinuationContent', () => {
  it('reuses the persisted subject and material for a verdict continuation', () => {
    const result = resolveFrozenContinuationContent(
      stateWithMaterial({ content: MATERIAL, materialDigest: MATERIAL_DIGEST }),
      VERDICT_CONTINUATION,
    );

    expect(result.kind).toBe('reuse');
    if (result.kind !== 'reuse') throw new TypeError('expected reuse');
    expect(result.content.content).toBe(MATERIAL);
    expect(result.content.reviewedContentDigest).toBe(MATERIAL_DIGEST);
    expect(result.content.reviewSubject.subjectDigest).toBe(SUBJECT_DIGEST);
  });

  it('reuses material carried by a spent attempt', () => {
    // The attempt is `rejected`; its bytes remain authoritative for the
    // obligation, so a verdict continuation must not fall back to re-derivation.
    const result = resolveFrozenContinuationContent(
      stateWithMaterial({ content: MATERIAL, materialDigest: MATERIAL_DIGEST }),
      VERDICT_CONTINUATION,
    );
    expect(result.kind).toBe('reuse');
  });

  it('fails closed instead of re-deriving when the persisted material is gone', () => {
    const result = resolveFrozenContinuationContent(
      stateWithMaterial(undefined),
      VERDICT_CONTINUATION,
    );

    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') throw new TypeError('expected blocked');
    expect(JSON.parse(result.message).code).toBe('REVIEW_MATERIAL_INTEGRITY_FAILED');
  });

  it('fails closed when the persisted material no longer matches its digest', () => {
    const result = resolveFrozenContinuationContent(
      stateWithMaterial({ content: 'tampered', materialDigest: MATERIAL_DIGEST }),
      VERDICT_CONTINUATION,
    );

    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') throw new TypeError('expected blocked');
    expect(JSON.parse(result.message).code).toBe('REVIEW_MATERIAL_INTEGRITY_FAILED');
  });

  it('does not apply without a verdict — the repair retry still derives content', () => {
    const result = resolveFrozenContinuationContent(
      stateWithMaterial({ content: MATERIAL, materialDigest: MATERIAL_DIGEST }),
      {
        policy: 'host_task_required',
        args: { branch: 'feature-x', reviewObligationId: OBLIGATION_ID },
      },
    );
    expect(result.kind).toBe('not_applicable');
  });

  it('does not apply when the named obligation carries no frozen subject', () => {
    const base = stateWithMaterial({ content: MATERIAL, materialDigest: MATERIAL_DIGEST });
    const withoutSubject = {
      ...base,
      reviewAssurance: {
        ...base.reviewAssurance!,
        obligations: [{ ...obligation(), reviewSubject: undefined }],
      },
    } as SessionState;

    expect(resolveFrozenContinuationContent(withoutSubject, VERDICT_CONTINUATION).kind).toBe(
      'not_applicable',
    );
  });
});

describe('assertFrozenSubjectUnchanged', () => {
  const state = stateWithMaterial({ content: MATERIAL, materialDigest: MATERIAL_DIGEST });
  const repairRetry = {
    policy: 'host_task_required',
    args: { branch: 'feature-x', reviewObligationId: OBLIGATION_ID },
  };

  function derived(subjectDigest: string) {
    return {
      content: MATERIAL,
      reviewedContentDigest: MATERIAL_DIGEST,
      reviewSubject: {
        kind: 'content' as const,
        source: { kind: 'inline' as const, mediaType: 'text' as const },
        materialDigest: MATERIAL_DIGEST,
        subjectDigest,
        lineCount: 1,
      },
    };
  }

  it('accepts a re-derived subject identical to the frozen one', () => {
    expect(assertFrozenSubjectUnchanged(state, repairRetry, derived(SUBJECT_DIGEST))).toBeNull();
  });

  it('blocks a re-derived subject that differs from the frozen one', () => {
    const block = assertFrozenSubjectUnchanged(state, repairRetry, derived('f'.repeat(64)));

    expect(block).not.toBeNull();
    expect(JSON.parse(block!).code).toBe('REVIEW_SUBJECT_DIGEST_MISMATCH');
  });

  it('leaves findings submissions to the attestation pipeline', () => {
    // Running here would pre-empt attestation validation and misreport a call
    // whose actual defect is a missing or forged attestation.
    const block = assertFrozenSubjectUnchanged(
      state,
      { ...repairRetry, args: { ...repairRetry.args, reviewFindings: {} as never } },
      derived('f'.repeat(64)),
    );
    expect(block).toBeNull();
  });

  it('does nothing without a named obligation', () => {
    expect(
      assertFrozenSubjectUnchanged(
        state,
        { policy: 'host_task_required', args: { branch: 'feature-x' } },
        derived('f'.repeat(64)),
      ),
    ).toBeNull();
  });
});
