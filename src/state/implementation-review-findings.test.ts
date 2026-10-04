import { describe, expect, it } from 'vitest';
import {
  projectOpenImplementationChallengeIds,
  projectUnaddressedImplementationChallengeIds,
} from './implementation-review-findings.js';
import type { ReviewFindings } from './evidence.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

function findings(
  challenges: { challengeId: string; kind: 'implementation_challenge'; outcome: 'fail' }[],
): ReviewFindings {
  return { challenges } as unknown as ReviewFindings;
}

describe('implementation review findings projections', () => {
  it('projects only open challenges without current-digest author resolutions', () => {
    const history = [
      findings([{ challengeId: A, kind: 'implementation_challenge', outcome: 'fail' }]),
    ];
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
    const history = [
      findings([
        { challengeId: A, kind: 'implementation_challenge', outcome: 'fail' },
        { challengeId: B, kind: 'implementation_challenge', outcome: 'fail' },
      ]),
    ];

    expect(
      projectUnaddressedImplementationChallengeIds(
        history,
        [{ challengeId: A, implementationDigest: 'current' }],
        'current',
      ),
    ).toEqual([B]);
  });
});
