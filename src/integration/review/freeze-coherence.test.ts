/**
 * @module integration/review/freeze-coherence.test
 * @description Creation-time coherence between the durable repository
 *              evidence freeze record and the frozen repository authority.
 *
 * Invariant under test (no third state, no legacy exception):
 *   plan/architecture obligations MUST carry the record
 *   available   ⇔ authority present
 *   unavailable ⇔ authority absent
 *
 * @test-policy HAPPY, BAD
 */

import { describe, expect, it } from 'vitest';
import { artifactReviewSubjectScope, createReviewObligation } from './assurance.js';
import { assertRepositoryFreezeCoherence } from './freeze-coherence.js';

const NOW = '2026-08-15T10:00:00.000Z';
const IDENTITY = { kind: 'local' as const, rootCommitDigest: 'sha256:' + 'a'.repeat(64) };
const AUTHORITY = {
  kind: 'context' as const,
  context: { kind: 'commit' as const, repositoryIdentity: IDENTITY, objectSha: 'c'.repeat(40) },
};

function planInput(overrides: Record<string, unknown> = {}) {
  return {
    obligationType: 'plan' as const,
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'plan-digest',
    reviewSubjectScope: artifactReviewSubjectScope('plan', '## Approach\nBody', 'plan-digest'),
    repositoryEvidenceFreeze: {
      kind: 'unavailable' as const,
      reason: 'repository_unavailable' as const,
    },
    ...overrides,
  };
}

describe('assertRepositoryFreezeCoherence', () => {
  it('HAPPY: the two legal plan/architecture states pass', () => {
    expect(() =>
      assertRepositoryFreezeCoherence({
        obligationType: 'plan',
        repositoryAuthority: AUTHORITY,
        repositoryEvidenceFreeze: { kind: 'available' },
      }),
    ).not.toThrow();
    expect(() =>
      assertRepositoryFreezeCoherence({
        obligationType: 'architecture',
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      }),
    ).not.toThrow();
  });

  it('HAPPY: review obligations without a record pass', () => {
    expect(() =>
      assertRepositoryFreezeCoherence({
        obligationType: 'review',
        repositoryAuthority: AUTHORITY,
      }),
    ).not.toThrow();
  });

  it('BAD: plan without a record throws fail-closed', () => {
    expect(() =>
      assertRepositoryFreezeCoherence({
        obligationType: 'plan',
      }),
    ).toThrow(/FAIL_CLOSED/);
  });

  it('BAD: architecture without a record throws fail-closed', () => {
    expect(() =>
      assertRepositoryFreezeCoherence({
        obligationType: 'architecture',
        repositoryAuthority: AUTHORITY,
      }),
    ).toThrow(/FAIL_CLOSED/);
  });

  it('BAD: available freeze without authority throws fail-closed', () => {
    expect(() =>
      assertRepositoryFreezeCoherence({
        obligationType: 'plan',
        repositoryEvidenceFreeze: { kind: 'available' },
      }),
    ).toThrow(/FAIL_CLOSED/);
  });

  it('BAD: unavailable freeze with authority throws fail-closed', () => {
    expect(() =>
      assertRepositoryFreezeCoherence({
        obligationType: 'plan',
        repositoryAuthority: AUTHORITY,
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'head_unavailable' },
      }),
    ).toThrow(/FAIL_CLOSED/);
  });

  it('BAD: non-context obligations must not carry the record', () => {
    expect(() =>
      assertRepositoryFreezeCoherence({
        obligationType: 'review',
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'freeze_failed' },
      }),
    ).toThrow(/FAIL_CLOSED/);
  });
});

describe('createReviewObligation freeze coherence', () => {
  it('HAPPY: mints a coherent available record with authority', () => {
    const obligation = createReviewObligation(
      planInput({
        repositoryAuthority: AUTHORITY,
        repositoryEvidenceFreeze: { kind: 'available' },
      }),
    );
    expect(obligation.repositoryAuthority?.kind).toBe('context');
    expect(obligation.repositoryEvidenceFreeze).toEqual({ kind: 'available' });
  });

  it('HAPPY: mints a coherent unavailable record without authority', () => {
    const obligation = createReviewObligation(planInput());
    expect(obligation.repositoryAuthority).toBeUndefined();
    expect(obligation.repositoryEvidenceFreeze).toMatchObject({
      kind: 'unavailable',
      reason: 'repository_unavailable',
    });
  });

  it('BAD: plan without a record throws at minting', () => {
    expect(() =>
      createReviewObligation({
        ...planInput(),
        repositoryEvidenceFreeze: undefined,
      }),
    ).toThrow(/FAIL_CLOSED/);
  });

  it('BAD: contradictory records throw at minting', () => {
    expect(() =>
      createReviewObligation(
        planInput({
          repositoryAuthority: undefined,
          repositoryEvidenceFreeze: { kind: 'available' },
        }),
      ),
    ).toThrow(/FAIL_CLOSED/);
    expect(() =>
      createReviewObligation(
        planInput({
          repositoryAuthority: AUTHORITY,
          repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'freeze_failed' },
        }),
      ),
    ).toThrow(/FAIL_CLOSED/);
  });
});
