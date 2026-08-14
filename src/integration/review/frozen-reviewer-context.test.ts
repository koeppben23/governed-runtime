import { describe, expect, it } from 'vitest';
import {
  hashCanonicalContentSubject,
  hashCanonicalReviewContent,
} from '../../shared/review-subject.js';
import {
  verifyFrozenMaterialForObligation,
  verifyFrozenReviewerContext,
} from './frozen-reviewer-context.js';
import type { ReviewObligation } from '../../state/evidence.js';

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
  maxReviewerOutputRepairAttempts: 1,
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
    const result = verifyFrozenReviewerContext(obligation, {
      content,
      materialDigest,
      subjectDigest,
    });

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
      verifyFrozenReviewerContext(obligation, {
        content: 'tampered\n',
        materialDigest,
        subjectDigest,
      }),
    ).toEqual({
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'persisted material digest does not match its canonical content',
    });
  });
});

describe('verifyFrozenMaterialForObligation', () => {
  const artifactObligation: ReviewObligation = {
    obligationId: '44444444-4444-4444-8444-444444444444',
    obligationType: 'architecture',
    iteration: 0,
    planVersion: 1,
    criteriaVersion: 'p41-v1',
    mandateDigest: 'mandate-digest',
    maxReviewerOutputRepairAttempts: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    pluginHandshakeAt: null,
    status: 'pending',
    invocationId: null,
    blockedCode: null,
    fulfilledAt: null,
    consumedAt: null,
    subjectDigest: 'artifact-digest-D2',
    reviewMaterial: {
      content: '# ADR\nBody',
      materialDigest: hashCanonicalReviewContent('# ADR\nBody'),
      subjectDigest: 'artifact-digest-D2',
    },
    reviewSubjectScope: {
      kind: 'artifact',
      artifact: {
        kind: 'adr',
        digest: 'artifact-digest-D2',
        sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'ADR' }]],
      },
    },
  };

  it('accepts an artifact obligation whose material generation matches the subject digest', () => {
    const result = verifyFrozenMaterialForObligation(
      artifactObligation,
      artifactObligation.reviewMaterial!,
    );
    expect(result).toEqual({ kind: 'ok', context: null });
  });

  it('blocks an artifact obligation whose material generation binds to a different digest', () => {
    const mismatched = {
      ...artifactObligation.reviewMaterial!,
      subjectDigest: 'artifact-digest-D1',
    };
    const result = verifyFrozenMaterialForObligation(artifactObligation, mismatched);
    expect(result).toEqual({
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'frozen material generation does not match the artifact subject digest',
    });
  });

  it('blocks an artifact obligation whose scope digest diverges from the subject digest', () => {
    // Fully self-consistent material block (D2) with a scope tampered to D1:
    // the subject identity chain must be transitively closed.
    const tampered: ReviewObligation = {
      ...artifactObligation,
      reviewSubjectScope: {
        kind: 'artifact',
        artifact: {
          ...(
            artifactObligation.reviewSubjectScope as Extract<
              ReviewObligation['reviewSubjectScope'],
              { kind: 'artifact' }
            >
          ).artifact,
          digest: 'artifact-digest-D1',
        },
      },
    };
    const result = verifyFrozenMaterialForObligation(tampered, tampered.reviewMaterial!);
    expect(result).toEqual({
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
      reason: 'frozen artifact scope does not match the obligation subject digest',
    });
  });

  it('blocks an artifact obligation whose artifactKind does not match the obligation type', () => {
    const tampered: ReviewObligation = {
      ...artifactObligation,
      reviewSubjectScope: {
        kind: 'artifact',
        artifact: {
          ...(
            artifactObligation.reviewSubjectScope as Extract<
              ReviewObligation['reviewSubjectScope'],
              { kind: 'artifact' }
            >
          ).artifact,
          kind: 'plan',
        },
      },
    };
    const result = verifyFrozenMaterialForObligation(tampered, tampered.reviewMaterial!);
    expect(result).toMatchObject({
      kind: 'blocked',
      code: 'REVIEW_MATERIAL_INTEGRITY_FAILED',
    });
  });

  it('routes standalone subjects through the full frozen context verification', () => {
    const result = verifyFrozenMaterialForObligation(obligation, {
      content,
      materialDigest,
      subjectDigest,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.context?.reviewSubject).toEqual(obligation.reviewSubject);
    }
  });
});
