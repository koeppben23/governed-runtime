import { describe, expect, it } from 'vitest';
import { makeState } from '../fixtures.js';
import { evaluateCompleteness } from './completeness.js';

describe('peer review completeness regression', () => {
  it('is incomplete in REVIEW and complete only in REVIEW_COMPLETE', () => {
    const inProgress = evaluateCompleteness(makeState('PEER_REVIEW'));
    expect(inProgress.slots).toHaveLength(0);
    expect(inProgress.overallComplete).toBe(false);

    const completed = evaluateCompleteness(makeState('PEER_REVIEW_COMPLETE'));
    expect(completed.slots).toHaveLength(0);
    expect(completed.overallComplete).toBe(true);
  });
});
