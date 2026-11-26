import { describe, expect, it } from 'vitest';
import type { ReviewFindings } from './evidence.js';
import {
  projectImplementationChallengeDetails,
  projectImplementationChallengeResolutionRequirements,
  projectOpenImplementationChallengeIds,
  projectUnaddressedImplementationChallengeIds,
} from './implementation-review-findings.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PASSED = '00000000-0000-4000-8000-00000000000c';

function challenge(
  challengeId: string,
  outcome: 'pass' | 'fail' | 'not_verified',
  overrides: Record<string, unknown> = {},
) {
  return {
    challengeId,
    obligationId: '00000000-0000-4000-8000-0000000000ff',
    kind: 'implementation_challenge' as const,
    scenario: `Scenario ${challengeId}.`,
    claim: `Claim ${challengeId}.`,
    locations: ['src/example.ts'],
    evidenceRefs: [{ kind: 'implementation' as const, implementationDigest: 'impl-1' }],
    outcome,
    ...overrides,
  };
}

function findings(input: {
  challenges: ReturnType<typeof challenge>[];
  verdicts?: { challengeId: string; verdict: string }[];
  overallVerdict?: ReviewFindings['overallVerdict'];
}): ReviewFindings {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: input.overallVerdict ?? 'changes_requested',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: input.challenges,
    ...(input.verdicts ? { challengeResolutionVerdicts: input.verdicts } : {}),
  } as unknown as ReviewFindings;
}

describe('implementation-review-findings resolution requirements (#747)', () => {
  describe('implementation review findings projections (existing coverage)', () => {
    it('projects only open challenges without current-digest author resolutions', () => {
      const history = [findings({ challenges: [challenge(A, 'fail')] })];
      const resolutions = [{ challengeId: A, implementationDigest: 'current' }];

      expect(projectOpenImplementationChallengeIds(history)).toEqual([A]);
      expect(projectUnaddressedImplementationChallengeIds(history, resolutions, 'current')).toEqual(
        [],
      );
      expect(projectUnaddressedImplementationChallengeIds(history, resolutions, 'stale')).toEqual([
        A,
      ]);
    });

    it('keeps independently unresolved challenges in the current-digest projection', () => {
      const history = [findings({ challenges: [challenge(A, 'fail'), challenge(B, 'fail')] })];

      expect(
        projectUnaddressedImplementationChallengeIds(
          history,
          [{ challengeId: A, implementationDigest: 'current' }],
          'current',
        ),
      ).toEqual([B]);
    });
  });

  describe('projectImplementationChallengeResolutionRequirements', () => {
    it('partitions open challenges into targeted and unaddressed by current-digest resolution', () => {
      const requirements = projectImplementationChallengeResolutionRequirements({
        findingsHistory: [findings({ challenges: [challenge(A, 'fail'), challenge(B, 'fail')] })],
        challengeResolutions: [{ challengeId: A, implementationDigest: 'impl-1' }],
        implementationDigest: 'impl-1',
      });
      expect(requirements.targetedResolutionIds).toEqual([A]);
      expect(requirements.unaddressedPriorFailIds).toEqual([B]);
    });

    it('treats a stale-digest resolution as unaddressed', () => {
      const requirements = projectImplementationChallengeResolutionRequirements({
        findingsHistory: [findings({ challenges: [challenge(A, 'fail')] })],
        challengeResolutions: [{ challengeId: A, implementationDigest: 'impl-0' }],
        implementationDigest: 'impl-1',
      });
      expect(requirements.targetedResolutionIds).toEqual([]);
      expect(requirements.unaddressedPriorFailIds).toEqual([A]);
    });

    it('keeps both sets empty when no challenge ever failed', () => {
      const requirements = projectImplementationChallengeResolutionRequirements({
        findingsHistory: [findings({ challenges: [challenge(PASSED, 'pass')] })],
        challengeResolutions: [{ challengeId: PASSED, implementationDigest: 'impl-1' }],
        implementationDigest: 'impl-1',
      });
      expect(requirements.targetedResolutionIds).toEqual([]);
      expect(requirements.unaddressedPriorFailIds).toEqual([]);
    });

    it('treats a challenge closed by an independent resolved verdict as neither targeted nor unaddressed', () => {
      const requirements = projectImplementationChallengeResolutionRequirements({
        findingsHistory: [
          findings({ challenges: [challenge(A, 'fail')] }),
          findings({
            challenges: [],
            verdicts: [{ challengeId: A, verdict: 'resolved' }],
            overallVerdict: 'accept',
          }),
        ],
        challengeResolutions: [{ challengeId: A, implementationDigest: 'impl-1' }],
        implementationDigest: 'impl-1',
      });
      expect(requirements.targetedResolutionIds).toEqual([]);
      expect(requirements.unaddressedPriorFailIds).toEqual([]);
    });

    it('keeps a still_failing verdict open and re-targetable after a new digest resolution', () => {
      const requirements = projectImplementationChallengeResolutionRequirements({
        findingsHistory: [
          findings({ challenges: [challenge(A, 'fail')] }),
          findings({ challenges: [], verdicts: [{ challengeId: A, verdict: 'still_failing' }] }),
        ],
        challengeResolutions: [{ challengeId: A, implementationDigest: 'impl-1' }],
        implementationDigest: 'impl-1',
      });
      expect(requirements.targetedResolutionIds).toEqual([A]);
      expect(requirements.unaddressedPriorFailIds).toEqual([]);
    });

    it('does not let an unable_to_review resolved verdict close a challenge', () => {
      const requirements = projectImplementationChallengeResolutionRequirements({
        findingsHistory: [
          findings({ challenges: [challenge(A, 'fail')] }),
          findings({
            challenges: [],
            verdicts: [{ challengeId: A, verdict: 'resolved' }],
            overallVerdict: 'unable_to_review',
          }),
        ],
        challengeResolutions: [{ challengeId: A, implementationDigest: 'impl-1' }],
        implementationDigest: 'impl-1',
      });
      expect(requirements.targetedResolutionIds).toEqual([A]);
    });

    it('ignores non-implementation challenges', () => {
      const requirements = projectImplementationChallengeResolutionRequirements({
        findingsHistory: [
          findings({
            challenges: [
              {
                ...challenge(A, 'fail'),
                kind: 'design_challenge' as never,
              },
            ],
          }),
        ],
        challengeResolutions: [{ challengeId: A, implementationDigest: 'impl-1' }],
        implementationDigest: 'impl-1',
      });
      expect(requirements.targetedResolutionIds).toEqual([]);
      expect(requirements.unaddressedPriorFailIds).toEqual([]);
    });
  });

  describe('projectUnaddressedImplementationChallengeIds', () => {
    it('matches the unaddressed partition of the requirements projection', () => {
      const history = [
        findings({ challenges: [challenge(A, 'fail'), challenge(B, 'not_verified')] }),
      ];
      const resolutions = [{ challengeId: A, implementationDigest: 'impl-1' }];
      expect(projectUnaddressedImplementationChallengeIds(history, resolutions, 'impl-1')).toEqual([
        B,
      ]);
    });
  });

  describe('projectImplementationChallengeDetails', () => {
    it('keeps the first failing origin and ignores later non-failing re-emissions', () => {
      const details = projectImplementationChallengeDetails([
        findings({ challenges: [challenge(A, 'fail')] }),
        findings({ challenges: [challenge(A, 'pass')] }),
      ]);
      expect(details).toHaveLength(1);
      expect(details[0]).toMatchObject({
        challengeId: A,
        scenario: `Scenario ${A}.`,
        claim: `Claim ${A}.`,
        originOutcome: 'fail',
        locations: ['src/example.ts'],
      });
    });

    it('returns no details for passing challenges', () => {
      expect(
        projectImplementationChallengeDetails([
          findings({ challenges: [challenge(PASSED, 'pass')] }),
        ]),
      ).toEqual([]);
    });

    it('retains not_verified origins', () => {
      const details = projectImplementationChallengeDetails([
        findings({ challenges: [challenge(A, 'not_verified')] }),
      ]);
      expect(details[0]?.originOutcome).toBe('not_verified');
    });
  });

  describe('projectOpenImplementationChallengeIds (unchanged lifecycle projection)', () => {
    it('excludes a challenge whose latest verdict is resolved', () => {
      expect(
        projectOpenImplementationChallengeIds([
          findings({ challenges: [challenge(A, 'fail')] }),
          findings({ challenges: [], verdicts: [{ challengeId: A, verdict: 'resolved' }] }),
        ]),
      ).toEqual([]);
    });
  });
});
