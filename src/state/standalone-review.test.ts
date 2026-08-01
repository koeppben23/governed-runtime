import { describe, expect, it } from 'vitest';
import {
  STANDALONE_REVIEW_OBJECTIVES_PROFILE_VERSION,
  createStandaloneReviewTask,
} from './standalone-review.js';
import { deriveProofGraph } from '../audit/proofgraph/derive.js';
import { makeState } from '../fixtures.js';
import { prepareStandaloneReviewEvidence } from '../integration/tools/review-tool/preparation.js';

describe('standalone review deterministic task', () => {
  it('uses canonical defaults and stable null-provenance hypothesis claims', () => {
    const first = createStandaloneReviewTask({ subjectDigest: 'a'.repeat(64) });
    const second = createStandaloneReviewTask({ subjectDigest: 'a'.repeat(64) });

    expect(first).toEqual(second);
    expect(first.task.profileVersion).toBe(STANDALONE_REVIEW_OBJECTIVES_PROFILE_VERSION);
    expect(first.task.objectives).toHaveLength(3);
    expect(first.task.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signalClass: 'hypothesis',
          provenance: null,
          evidenceRefs: [],
          counterexampleRefs: [],
        }),
      ]),
    );
    expect(
      createStandaloneReviewTask({ subjectDigest: 'b'.repeat(64) }).task.claims[0]?.claimId,
    ).not.toBe(first.task.claims[0]?.claimId);
  });

  it('uses structured custom objectives without deriving objectives from subject text', () => {
    const { task } = createStandaloneReviewTask({
      subjectDigest: 'a'.repeat(64),
      objectives: [
        { objectiveId: 'api-contract', statement: 'The API contract remains compatible.' },
      ],
    });

    expect(task.objectives).toEqual([
      { objectiveId: 'api-contract', statement: 'The API contract remains compatible.' },
    ]);
    expect(task.claims).toHaveLength(1);
    expect(task.claims[0]).toMatchObject({
      statement: 'The API contract remains compatible.',
      provenance: null,
      signalClass: 'hypothesis',
    });
  });

  it('adds review claims to the graph as NOT_VERIFIED, never proven provider evidence', () => {
    const { task, requestedDigests } = createStandaloneReviewTask({
      subjectDigest: 'a'.repeat(64),
    });
    const projection = deriveProofGraph(
      makeState('READY', {
        standaloneReviewEvidence: [
          {
            kind: 'prepared',
            evidenceId: '00000000-0000-4000-8000-000000000001',
            preparedAt: '2026-01-01T00:00:00.000Z',
            task,
            requestedDigests,
          },
        ],
      }),
      [],
      [],
      '2026-01-01T00:00:00.000Z',
    );

    expect(projection.claims).toHaveLength(task.claims.length);
    expect(projection.claims.every((claim) => claim.verificationState === 'NOT_VERIFIED')).toBe(
      true,
    );
  });

  it('binds a branch review subject to its resolved head rather than its mutable branch name', () => {
    const args = { branch: 'feature', base: 'main' };
    const first = prepareStandaloneReviewEvidence(args, '2026-01-01T00:00:00.000Z', {
      branch: 'feature',
      baseBranch: 'main',
      resolvedBranchSha: 'a'.repeat(40),
      resolvedBaseSha: 'b'.repeat(40),
    });
    const second = prepareStandaloneReviewEvidence(args, '2026-01-01T00:00:00.000Z', {
      branch: 'feature',
      baseBranch: 'main',
      resolvedBranchSha: 'c'.repeat(40),
      resolvedBaseSha: 'b'.repeat(40),
    });

    expect(second.task.subjectDigest).not.toBe(first.task.subjectDigest);
  });
});
