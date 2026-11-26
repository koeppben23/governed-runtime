import { describe, expect, it } from 'vitest';
import { forcedConvergenceResponseFields } from './plan-review-exhaustion.js';
import { DISCARDED_REVIEW_DRAFT } from '../../../state/evidence-review.js';
import type { PlanRevisionResult } from './plan-types.js';

function revision(discarded: boolean): PlanRevisionResult {
  return {
    currentPlan: {} as PlanRevisionResult['currentPlan'],
    history: [{}, {}] as PlanRevisionResult['history'],
    revisionDelta: 'none',
    prevDigest: 'reviewed-digest',
    verdict: 'changes_requested',
    ...(discarded ? { discardedDraft: DISCARDED_REVIEW_DRAFT } : {}),
  };
}

describe('forced convergence response fields', () => {
  it('marks the exhausting revision as not adopted and names both user paths', () => {
    const fields = forcedConvergenceResponseFields(revision(true), true);
    expect(fields).toMatchObject({
      adopted: false,
      reviewCompletion: 'review_exhausted',
      currentPlanVersion: 3,
      discardedRevisionVersion: 4,
    });
    expect(fields.nextActions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/request-changes'),
        expect.stringContaining('/override-approve <Begründung>'),
      ]),
    );
    expect(String(fields.agentInstruction)).toContain('not adopted');
  });

  it('omits a discarded version when no revision accompanied the verdict', () => {
    const fields = forcedConvergenceResponseFields(revision(false), true);
    expect(fields).toMatchObject({ adopted: false, currentPlanVersion: 3 });
    expect(fields).not.toHaveProperty('discardedRevisionVersion');
    expect(String(fields.agentInstruction)).toContain('Do not submit another plan revision');
  });

  it('leaves an accepted review marked as adopted', () => {
    expect(forcedConvergenceResponseFields(revision(false), false)).toEqual({ adopted: true });
  });
});
