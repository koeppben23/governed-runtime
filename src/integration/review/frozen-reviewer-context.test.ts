import { describe, expect, it } from 'vitest';
import {
  hashCanonicalContentSubject,
  hashCanonicalReviewContent,
} from '../../shared/review-subject.js';
import { verifyFrozenReviewerContext } from './frozen-reviewer-context.js';

const content = 'canonical content\n';
const materialDigest = hashCanonicalReviewContent(content);
const subjectDigest = hashCanonicalContentSubject(materialDigest);
const obligation = {
  obligationId: '11111111-1111-4111-8111-111111111111',
  obligationType: 'review' as const,
  subjectDigest,
  iteration: 1,
  planVersion: 1,
  criteriaVersion: 'criteria-v1',
  mandateDigest: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z',
  pluginHandshakeAt: null,
  status: 'pending' as const,
  invocationId: null,
  blockedCode: null,
  fulfilledAt: null,
  consumedAt: null,
  reviewSubject: {
    kind: 'content' as const,
    source: { kind: 'inline' as const, mediaType: 'text' as const },
    materialDigest,
    subjectDigest,
    lineCount: 1,
  },
  reviewSubjectScope: { kind: 'content' as const, subjectDigest, lineCount: 1 },
};

describe('verifyFrozenReviewerContext', () => {
  it('returns the frozen subject, obligation scope, and anchor contract', () => {
    const result = verifyFrozenReviewerContext(obligation, { content, materialDigest });

    expect(result).toMatchObject({
      kind: 'ok',
      context: {
        reviewSubject: obligation.reviewSubject,
        reviewSubjectScope: obligation.reviewSubjectScope,
      },
    });
  });

  it('fails closed when persisted content does not match its material digest', () => {
    expect(
      verifyFrozenReviewerContext(obligation, { content: 'tampered\n', materialDigest }),
    ).toEqual({
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'persisted material digest does not match its canonical content',
    });
  });
});
