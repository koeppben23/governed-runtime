import { describe, it, expect } from 'vitest';
import type { SessionState } from '../../state/schema.js';
import {
  computeTargetedResolutionChallengeIds,
  computeUnaddressedPriorFailIds,
  isOpenImplementationChallenge,
} from './implement-review.js';

// #747 lifecycle semantics. An author resolution is advisory: it does NOT close
// a challenge, it moves it into the set the NEXT independent reviewer must judge.
//  - computeTargetedResolutionChallengeIds  = open(lifecycle) ∩ resolved(current digest)
//  - computeUnaddressedPriorFailIds         = open(lifecycle) \ resolved(current digest)
// Open-state is projected over the WHOLE implReviewFindings history: a failing
// origin whose latest independent verdict is not `resolved`.

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PASSED = '00000000-0000-4000-8000-00000000000c';

type Ch = { challengeId: string; kind: string; outcome: string };
type Vd = { challengeId: string; verdict: string };
type Findings = {
  challenges?: Ch[];
  challengeResolutionVerdicts?: Vd[];
  overallVerdict?: 'accept' | 'changes_requested' | 'unable_to_review';
};

function stateWith(input: {
  digest?: string;
  contentDigest?: string;
  challenges?: Ch[];
  findingsList?: Findings[];
  resolutions?: { challengeId: string; implementationDigest: string }[];
}): SessionState {
  const implReviewFindings =
    input.findingsList ?? (input.challenges ? [{ challenges: input.challenges }] : undefined);
  return {
    implementation: input.digest
      ? {
          digest: input.digest,
          candidate: {
            candidateDigest: input.digest,
            contentDigest: input.contentDigest ?? `${input.digest}-content`,
          },
        }
      : null,
    implReviewFindings,
    challengeResolutions: input.resolutions ?? [],
  } as unknown as SessionState;
}

describe('implement re-review challenge lifecycle (#747)', () => {
  describe('computeTargetedResolutionChallengeIds — the set the next reviewer MUST judge', () => {
    it('INCLUDES a prior failing challenge the author resolved for the current digest', () => {
      const state = stateWith({
        digest: 'impl-1',
        challenges: [
          { challengeId: A, kind: 'implementation_challenge', outcome: 'fail' },
          { challengeId: B, kind: 'implementation_challenge', outcome: 'fail' },
        ],
        resolutions: [{ challengeId: A, implementationDigest: 'impl-1' }],
      });
      // A is author-resolved for the current digest → the reviewer must judge A.
      // B has no resolution → it is NOT yet a targeted (reviewer-judged) challenge.
      expect(computeTargetedResolutionChallengeIds(state)).toEqual([A]);
    });

    it('does NOT target a resolution bound to a different implementation digest', () => {
      const state = stateWith({
        digest: 'impl-2',
        challenges: [{ challengeId: A, kind: 'implementation_challenge', outcome: 'fail' }],
        resolutions: [{ challengeId: A, implementationDigest: 'impl-1' }], // stale digest
      });
      expect(computeTargetedResolutionChallengeIds(state)).toEqual([]);
    });

    it('does NOT target a resolution from another candidate with identical content', () => {
      const state = stateWith({
        digest: 'candidate-b',
        contentDigest: 'shared-content',
        challenges: [{ challengeId: A, kind: 'implementation_challenge', outcome: 'fail' }],
        resolutions: [{ challengeId: A, implementationDigest: 'candidate-a' }],
      });

      expect(computeTargetedResolutionChallengeIds(state)).toEqual([]);
      expect(computeUnaddressedPriorFailIds(state)).toEqual([A]);
    });

    it('ignores non-implementation and passing challenges', () => {
      const state = stateWith({
        digest: 'impl-1',
        challenges: [
          { challengeId: PASSED, kind: 'implementation_challenge', outcome: 'pass' },
          { challengeId: A, kind: 'design_challenge', outcome: 'contradicted' },
        ],
        resolutions: [{ challengeId: PASSED, implementationDigest: 'impl-1' }],
      });
      expect(computeTargetedResolutionChallengeIds(state)).toEqual([]);
    });

    it('returns empty when there are no prior review findings', () => {
      expect(computeTargetedResolutionChallengeIds(stateWith({}))).toEqual([]);
    });
  });

  describe('computeUnaddressedPriorFailIds — prior failures the author has NOT resolved', () => {
    it('lists prior failing challenges with no current-digest resolution', () => {
      const state = stateWith({
        digest: 'impl-1',
        challenges: [
          { challengeId: A, kind: 'implementation_challenge', outcome: 'fail' },
          { challengeId: B, kind: 'implementation_challenge', outcome: 'not_verified' },
        ],
        resolutions: [{ challengeId: A, implementationDigest: 'impl-1' }],
      });
      // A is addressed → only B remains unaddressed.
      expect(computeUnaddressedPriorFailIds(state)).toEqual([B]);
    });

    it('counts a stale-digest resolution as NOT addressing the challenge', () => {
      const state = stateWith({
        digest: 'impl-2',
        challenges: [{ challengeId: A, kind: 'implementation_challenge', outcome: 'fail' }],
        resolutions: [{ challengeId: A, implementationDigest: 'impl-1' }],
      });
      expect(computeUnaddressedPriorFailIds(state)).toEqual([A]);
    });

    it('is empty when every prior failing challenge is resolved for the current digest', () => {
      const state = stateWith({
        digest: 'impl-1',
        challenges: [{ challengeId: A, kind: 'implementation_challenge', outcome: 'fail' }],
        resolutions: [{ challengeId: A, implementationDigest: 'impl-1' }],
      });
      expect(computeUnaddressedPriorFailIds(state)).toEqual([]);
    });

    it('returns empty when there are no prior review findings', () => {
      expect(computeUnaddressedPriorFailIds(stateWith({}))).toEqual([]);
    });
  });

  it('the two sets partition the prior failing challenges (no overlap, union = prior fails)', () => {
    const state = stateWith({
      digest: 'impl-1',
      challenges: [
        { challengeId: A, kind: 'implementation_challenge', outcome: 'fail' },
        { challengeId: B, kind: 'implementation_challenge', outcome: 'not_verified' },
        { challengeId: PASSED, kind: 'implementation_challenge', outcome: 'pass' },
      ],
      resolutions: [{ challengeId: A, implementationDigest: 'impl-1' }],
    });
    const targeted = computeTargetedResolutionChallengeIds(state);
    const unaddressed = computeUnaddressedPriorFailIds(state);
    expect(targeted).toEqual([A]);
    expect(unaddressed).toEqual([B]);
    expect(targeted.some((id) => unaddressed.includes(id))).toBe(false);
  });

  describe('lifecycle projection across multiple review rounds (#747 multi-round)', () => {
    it('keeps a challenge OPEN across rounds when the latest verdict is still_failing', () => {
      // Round 1: A fails. Round 2: reviewer verdict still_failing (A is no longer
      // re-emitted as a challenge object, only as a verdict). A must remain open.
      const state = stateWith({
        digest: 'impl-2',
        findingsList: [
          { challenges: [{ challengeId: A, kind: 'implementation_challenge', outcome: 'fail' }] },
          { challengeResolutionVerdicts: [{ challengeId: A, verdict: 'still_failing' }] },
        ],
        resolutions: [{ challengeId: A, implementationDigest: 'impl-2' }],
      });
      expect(isOpenImplementationChallenge(state, A)).toBe(true);
      expect(computeTargetedResolutionChallengeIds(state)).toEqual([A]);
    });

    it('keeps a challenge OPEN when the latest verdict is not_verified', () => {
      const state = stateWith({
        digest: 'impl-2',
        findingsList: [
          { challenges: [{ challengeId: A, kind: 'implementation_challenge', outcome: 'fail' }] },
          { challengeResolutionVerdicts: [{ challengeId: A, verdict: 'not_verified' }] },
        ],
      });
      expect(isOpenImplementationChallenge(state, A)).toBe(true);
      expect(computeUnaddressedPriorFailIds(state)).toEqual([A]);
    });

    it('CLOSES a challenge once the latest independent verdict is resolved', () => {
      const state = stateWith({
        digest: 'impl-3',
        findingsList: [
          { challenges: [{ challengeId: A, kind: 'implementation_challenge', outcome: 'fail' }] },
          { challengeResolutionVerdicts: [{ challengeId: A, verdict: 'still_failing' }] },
          { challengeResolutionVerdicts: [{ challengeId: A, verdict: 'resolved' }] },
        ],
        resolutions: [{ challengeId: A, implementationDigest: 'impl-3' }],
      });
      expect(isOpenImplementationChallenge(state, A)).toBe(false);
      expect(computeTargetedResolutionChallengeIds(state)).toEqual([]);
      expect(computeUnaddressedPriorFailIds(state)).toEqual([]);
    });

    it('keeps a challenge OPEN when persisted unable_to_review findings claim resolved', () => {
      const state = stateWith({
        digest: 'impl-3',
        findingsList: [
          { challenges: [{ challengeId: A, kind: 'implementation_challenge', outcome: 'fail' }] },
          {
            overallVerdict: 'unable_to_review',
            challengeResolutionVerdicts: [{ challengeId: A, verdict: 'resolved' }],
          },
        ],
        resolutions: [{ challengeId: A, implementationDigest: 'impl-3' }],
      });
      expect(isOpenImplementationChallenge(state, A)).toBe(true);
      expect(computeTargetedResolutionChallengeIds(state)).toEqual([A]);
    });

    it('later findings override an earlier resolved verdict (re-opened by a subsequent still_failing)', () => {
      const state = stateWith({
        digest: 'impl-4',
        findingsList: [
          { challenges: [{ challengeId: A, kind: 'implementation_challenge', outcome: 'fail' }] },
          { challengeResolutionVerdicts: [{ challengeId: A, verdict: 'resolved' }] },
          { challengeResolutionVerdicts: [{ challengeId: A, verdict: 'still_failing' }] },
        ],
      });
      // Latest verdict wins → open again.
      expect(isOpenImplementationChallenge(state, A)).toBe(true);
    });

    it('an unknown id is never open', () => {
      const state = stateWith({
        digest: 'impl-1',
        challenges: [{ challengeId: A, kind: 'implementation_challenge', outcome: 'fail' }],
      });
      expect(isOpenImplementationChallenge(state, B)).toBe(false);
    });
  });
});
