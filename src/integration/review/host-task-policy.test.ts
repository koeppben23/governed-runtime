import { describe, expect, it } from 'vitest';
import { FIXED_TIME, IMPL_EVIDENCE, VALIDATION_PASSED, makeState } from '../../fixtures.js';
import type { ReviewObligation } from '../../state/evidence.js';
import { buildHostTaskChallengeContract } from './host-task-policy.js';

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
