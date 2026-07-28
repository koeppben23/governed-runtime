import { describe, expect, it } from 'vitest';
import type { SessionState } from '../../state/schema.js';
import { collectPreviouslyUsedChallengeIds } from './challenge-history.js';

const PLAN_ID = '00000000-0000-4000-8000-000000000011';
const ARCHITECTURE_ID = '00000000-0000-4000-8000-000000000012';
const IMPLEMENTATION_ID = '00000000-0000-4000-8000-000000000013';

function findings(challengeId: string) {
  return { challenges: [{ challengeId }] };
}

describe('collectPreviouslyUsedChallengeIds', () => {
  it('collects IDs from every persisted review-findings history in the session', () => {
    const state = {
      plan: { reviewFindings: [findings(PLAN_ID)] },
      architecture: { reviewFindings: [findings(ARCHITECTURE_ID)] },
      implReviewFindings: [findings(IMPLEMENTATION_ID)],
    } as unknown as SessionState;

    expect(collectPreviouslyUsedChallengeIds(state)).toEqual(
      expect.arrayContaining([PLAN_ID, ARCHITECTURE_ID, IMPLEMENTATION_ID]),
    );
  });
});
