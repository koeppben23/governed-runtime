/**
 * @module integration/opencode-governance-dispatch-cache.test
 * @description Bounded in-memory retention for settled native dispatches.
 */
import { describe, expect, it } from 'vitest';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import {
  MAX_ENROLLED_REVIEWER_BINDINGS,
  retireSettledDispatch,
  type NativeDispatchMemory,
} from './opencode-governance-dispatch-cache.js';
import type { GovernanceDelegationDispatch } from '../state/governance-activation.js';

function memory(): NativeDispatchMemory {
  return {
    dispatches: new Map<string, GovernanceDelegationDispatch>(),
    dispatchChildren: new Map<string, string>(),
    linking: new Map(),
    settledReviewerDispatches: new Set<string>(),
    enrolledReviewerDispatchKeys: new Set<string>(),
  };
}

describe('settled dispatch retention', () => {
  it('drops full reviewer objects and keeps bounded identity bindings', () => {
    const state = memory();
    const total = 10_000;
    for (let index = 0; index < total; index++) {
      const key = `reviewer-${index}`;
      state.dispatches.set(key, {
        agent: REVIEWER_SUBAGENT_TYPE,
      } as GovernanceDelegationDispatch);
      state.dispatchChildren.set(key, `child-${index}`);
      retireSettledDispatch(state, key, `child-${index}`, true);
    }

    expect(state.dispatches.size).toBe(0);
    expect(state.dispatchChildren.size).toBe(0);
    expect(state.linking.size).toBe(0);
    expect(state.settledReviewerDispatches.size).toBe(MAX_ENROLLED_REVIEWER_BINDINGS);
    expect(state.enrolledReviewerDispatchKeys.size).toBe(MAX_ENROLLED_REVIEWER_BINDINGS);
  });

  it('releases ordinary dispatch state without retaining a binding', () => {
    const state = memory();
    state.dispatches.set('ordinary', {
      agent: 'general',
    } as GovernanceDelegationDispatch);
    state.dispatchChildren.set('ordinary', 'child');
    state.enrolledReviewerDispatchKeys.add('ordinary');
    retireSettledDispatch(state, 'ordinary', 'child', false);

    expect(state.dispatches.size).toBe(0);
    expect(state.dispatchChildren.size).toBe(0);
    expect(state.settledReviewerDispatches.size).toBe(0);
    expect(state.enrolledReviewerDispatchKeys.size).toBe(0);
  });
});
