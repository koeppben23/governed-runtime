import { describe, expect, it } from 'vitest';
import { FIXED_TIME, IMPL_EVIDENCE, VALIDATION_PASSED, makeState } from '../../fixtures.js';
import type { ReviewObligation } from '../../state/evidence.js';
import { renderReviewerTaskPrompt } from './prompt-builders.js';
import { buildHostTaskChallengeContract } from './host-task-policy.js';
import { buildHostTaskChallengeResolutions } from './artifact-review-context.js';

const RESOLUTION = {
  challengeId: '33333333-3333-4333-8333-333333333333',
  implementationDigest: IMPL_EVIDENCE.digest,
  validationAttemptIds: ['22222222-2222-4222-8222-222222222222'],
  resolvedAt: FIXED_TIME,
};

const IMPLEMENTATION_DIGEST = IMPL_EVIDENCE.digest;

function obligation(): ReviewObligation {
  return {
    obligationId: '11111111-1111-4111-8111-111111111111',
    obligationType: 'implement',
    subjectDigest: 'test-subject-digest',
    iteration: 1,
    planVersion: 1,
    criteriaVersion: 'criteria-v1',
    mandateDigest: 'mandate-digest',
    maxReviewerOutputRepairAttempts: 1,
    createdAt: FIXED_TIME,
    pluginHandshakeAt: null,
    status: 'pending',
    invocationId: null,
    blockedCode: null,
    fulfilledAt: null,
    consumedAt: null,
    reviewSubjectScope: {
      kind: 'repository_change',
      paths: ['src/foo.ts'],
      revisions: ['base', 'head'],
    },
    requiredChallengeCount: 1,
    requiredChallengeKind: 'implementation_challenge',
  };
}

function implementationAttempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: '22222222-2222-4222-8222-222222222222',
    scope: 'implementation' as const,
    implementationDigest: IMPLEMENTATION_DIGEST,
    result: VALIDATION_PASSED[0]!,
    ...overrides,
  };
}

function evidence(state = makeState('IMPL_REVIEW', { implementation: IMPL_EVIDENCE })) {
  return buildHostTaskChallengeContract(state, obligation())?.evidenceRefs;
}

describe('implementation host-task challenge evidence', () => {
  it('includes the current implementation and a successful digest-bound validation attempt', () => {
    const instructions = evidence(
      makeState('IMPL_REVIEW', {
        implementation: IMPL_EVIDENCE,
        validationAttempts: [implementationAttempt()],
      }),
    );

    expect(instructions).toEqual([
      { kind: 'implementation', implementationDigest: IMPLEMENTATION_DIGEST },
      {
        kind: 'validation_attempt',
        attemptId: '22222222-2222-4222-8222-222222222222',
      },
    ]);
  });

  it.each([
    [
      'a mismatched implementation digest',
      implementationAttempt({ implementationDigest: 'stale-digest' }),
    ],
    [
      'a failed implementation attempt',
      implementationAttempt({ result: { ...VALIDATION_PASSED[0]!, passed: false } }),
    ],
    [
      'a baseline attempt',
      {
        attemptId: '22222222-2222-4222-8222-222222222222',
        scope: 'baseline' as const,
        planDigest: 'plan-digest',
        result: VALIDATION_PASSED[0]!,
      },
    ],
  ])('excludes %s', (_label, attempt) => {
    expect(
      evidence(
        makeState('IMPL_REVIEW', {
          implementation: IMPL_EVIDENCE,
          validationAttempts: [attempt] as never,
        }),
      ),
    ).toBeUndefined();
  });

  it('excludes stale attempts after implementation re-recording and absent evidence', () => {
    expect(
      evidence(
        makeState('IMPL_REVIEW', {
          implementation: { ...IMPL_EVIDENCE, digest: 'replacement-digest' },
          validationAttempts: [implementationAttempt()] as never,
        }),
      ),
    ).toBeUndefined();
    expect(evidence()).toBeUndefined();
  });
});

describe('host-task challenge resolutions (advisory NOT_VERIFIED)', () => {
  it('projects only resolutions bound to the current implementation digest', () => {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      challengeResolutions: [
        RESOLUTION,
        {
          ...RESOLUTION,
          challengeId: '44444444-4444-4444-8444-444444444444',
          implementationDigest: 'stale-digest',
        },
      ],
    });
    expect(buildHostTaskChallengeResolutions(state)).toEqual([RESOLUTION]);
  });

  it('returns an empty projection when no implementation or no matching resolution exists', () => {
    expect(
      buildHostTaskChallengeResolutions(
        makeState('IMPL_REVIEW', { implementation: IMPL_EVIDENCE }),
      ),
    ).toEqual([]);
    expect(buildHostTaskChallengeResolutions(makeState('IMPL_REVIEW'))).toEqual([]);
  });

  it('host-task prompt renders the advisory resolutions section when present', () => {
    const prompt = renderReviewerTaskPrompt({
      iteration: 1,
      planVersion: 1,
      obligationId: '11111111-1111-4111-8111-111111111111',
      mandateDigest: 'mandate',
      criteriaVersion: 'criteria-v1',
      subjectLabel: 'the implementation',
      challengeResolutions: [RESOLUTION],
      repositoryDiscoverySnapshot: null,
    });
    expect(prompt).toContain('## Advisory Challenge Resolutions (NOT_VERIFIED)');
    expect(prompt).toContain(RESOLUTION.challengeId);
  });

  it('host-task prompt omits the advisory resolutions section when empty', () => {
    const prompt = renderReviewerTaskPrompt({
      iteration: 1,
      planVersion: 1,
      obligationId: '11111111-1111-4111-8111-111111111111',
      mandateDigest: 'mandate',
      criteriaVersion: 'criteria-v1',
      subjectLabel: 'the implementation',
      challengeResolutions: [],
      repositoryDiscoverySnapshot: null,
    });
    expect(prompt).not.toContain('Advisory Challenge Resolutions');
  });
});
