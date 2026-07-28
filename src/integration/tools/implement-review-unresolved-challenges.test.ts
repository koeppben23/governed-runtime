import { describe, it, expect } from 'vitest';
import type { SessionState } from '../../state/schema.js';
import { computeUnresolvedImplementationChallengeIds } from './implement-review.js';

// Regression for the inverted-semantics bug: `unresolvedImplementationChallengeIds`
// must be the genuinely-OPEN set (prior iteration's non-passing implementation
// challenges MINUS author-resolved ones), NOT the set of already-resolved IDs.

const OPEN_A = '00000000-0000-4000-8000-00000000000a';
const OPEN_B = '00000000-0000-4000-8000-00000000000b';
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

describe('computeUnresolvedImplementationChallengeIds (inverted-bug regression)', () => {
  it('returns the non-passing implementation challenges from the last iteration', () => {
    const state = stateWith({
      digest: 'impl-1',
      challenges: [
        { challengeId: OPEN_A, kind: 'implementation_challenge', outcome: 'fail' },
        { challengeId: OPEN_B, kind: 'implementation_challenge', outcome: 'not_verified' },
        { challengeId: PASSED, kind: 'implementation_challenge', outcome: 'pass' },
      ],
    });
    expect(computeUnresolvedImplementationChallengeIds(state)).toEqual([OPEN_A, OPEN_B]);
  });

  it('excludes challenges already resolved by the author for the current digest', () => {
    const state = stateWith({
      digest: 'impl-1',
      challenges: [
        { challengeId: OPEN_A, kind: 'implementation_challenge', outcome: 'fail' },
        { challengeId: OPEN_B, kind: 'implementation_challenge', outcome: 'fail' },
      ],
      resolutions: [{ challengeId: OPEN_A, implementationDigest: 'impl-1' }],
    });
    // OPEN_A is resolved for the current digest → only OPEN_B remains open.
    expect(computeUnresolvedImplementationChallengeIds(state)).toEqual([OPEN_B]);
  });

  it('does NOT exclude a resolution bound to a different implementation digest', () => {
    const state = stateWith({
      digest: 'impl-2',
      challenges: [{ challengeId: OPEN_A, kind: 'implementation_challenge', outcome: 'fail' }],
      resolutions: [{ challengeId: OPEN_A, implementationDigest: 'impl-1' }], // stale digest
    });
    expect(computeUnresolvedImplementationChallengeIds(state)).toEqual([OPEN_A]);
  });

  it('ignores non-implementation and passing challenges', () => {
    const state = stateWith({
      digest: 'impl-1',
      challenges: [
        { challengeId: PASSED, kind: 'implementation_challenge', outcome: 'pass' },
        { challengeId: OPEN_A, kind: 'design_challenge', outcome: 'contradicted' },
      ],
    });
    expect(computeUnresolvedImplementationChallengeIds(state)).toEqual([]);
  });

  it('returns empty when there are no prior review findings', () => {
    expect(computeUnresolvedImplementationChallengeIds(stateWith({}))).toEqual([]);
  });
});
