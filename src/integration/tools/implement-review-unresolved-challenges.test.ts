import { describe, it, expect } from 'vitest';
import type { SessionState } from '../../state/schema.js';
import {
  computeTargetedResolutionChallengeIds,
  computeUnaddressedPriorFailIds,
} from './implement-review.js';

// #747 lifecycle semantics. An author resolution is advisory: it does NOT close
// a challenge, it moves it into the set the NEXT independent reviewer must judge.
//  - computeTargetedResolutionChallengeIds  = prior fail/not_verified ∩ resolved(current digest)
//  - computeUnaddressedPriorFailIds         = prior fail/not_verified \ resolved(current digest)

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PASSED = '00000000-0000-4000-8000-00000000000c';

function stateWith(input: {
  digest?: string;
  challenges?: { challengeId: string; kind: string; outcome: string }[];
  resolutions?: { challengeId: string; implementationDigest: string }[];
}): SessionState {
  return {
    implementation: input.digest ? { digest: input.digest } : null,
    implReviewFindings: input.challenges ? [{ challenges: input.challenges }] : undefined,
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
});
