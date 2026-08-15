/**
 * @module integration/review/freeze-coherence.test
 * @description Creation-time coherence between the durable repository
 *              evidence freeze record and the frozen repository authority.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, expect, it } from 'vitest';
import { artifactReviewSubjectScope, createReviewObligation } from './assurance.js';
import { assertRepositoryFreezeCoherence } from './freeze-coherence.js';

const NOW = '2026-08-15T10:00:00.000Z';
const IDENTITY = { kind: 'local' as const, rootCommitDigest: 'sha256:' + 'a'.repeat(64) };

function planInput(overrides: Record<string, unknown> = {}) {
  return {
    obligationType: 'plan' as const,
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'plan-digest',
    reviewSubjectScope: artifactReviewSubjectScope('plan', '## Approach\nBody', 'plan-digest'),
    repositoryAuthority: {
      kind: 'context' as const,
      context: { kind: 'commit' as const, repositoryIdentity: IDENTITY, objectSha: 'c'.repeat(40) },
    },
    ...overrides,
  };
}

describe('assertRepositoryFreezeCoherence', () => {
  it('HAPPY: coherent combinations pass', () => {
    expect(() =>
      assertRepositoryFreezeCoherence({
        repositoryAuthority: planInput().repositoryAuthority,
        repositoryEvidenceFreeze: { kind: 'available' },
      }),
    ).not.toThrow();
    expect(() =>
      assertRepositoryFreezeCoherence({
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      }),
    ).not.toThrow();
    expect(() => assertRepositoryFreezeCoherence({})).not.toThrow();
  });

  it('BAD: available freeze without authority throws fail-closed', () => {
    expect(() =>
      assertRepositoryFreezeCoherence({ repositoryEvidenceFreeze: { kind: 'available' } }),
    ).toThrow(/FAIL_CLOSED/);
  });

  it('BAD: unavailable freeze with authority throws fail-closed', () => {
    expect(() =>
      assertRepositoryFreezeCoherence({
        repositoryAuthority: planInput().repositoryAuthority,
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'head_unavailable' },
      }),
    ).toThrow(/FAIL_CLOSED/);
  });
});

describe('createReviewObligation freeze coherence', () => {
  it('HAPPY: mints a coherent available record', () => {
    const obligation = createReviewObligation(
      planInput({ repositoryEvidenceFreeze: { kind: 'available' } }),
    );
    expect(obligation.repositoryAuthority?.kind).toBe('context');
    expect(obligation.repositoryEvidenceFreeze).toEqual({ kind: 'available' });
  });

  it('BAD: mints nothing when the record contradicts the authority', () => {
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
        planInput({ repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'freeze_failed' } }),
      ),
    ).toThrow(/FAIL_CLOSED/);
  });
});
