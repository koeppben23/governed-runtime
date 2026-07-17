/**
 * @module integration/review-context-serializer.test
 * @description F9 tests: canonical review-context serializer.
 *
 * The iteration/planVersion context an agent must echo into the reviewer prompt
 * is emitted by two blocked-output builders and validated by a third code path
 * (enforcement promptContainsValue). renderReviewContext is the single canonical
 * form; this test locks its shape and proves it satisfies enforcement on the
 * first attempt — the regression class behind the observed
 * SUBAGENT_PROMPT_MISSING_CONTEXT first-attempt block.
 *
 * @test-policy HAPPY, EDGE, REGRESSION.
 */

import { describe, it, expect } from 'vitest';
import { renderReviewContext } from './prompt-builders.js';
import { promptContainsValue, extractContentMeta } from './enforcement/extraction.js';

describe('F9: renderReviewContext canonical serializer', () => {
  it('renders iteration and planVersion in the canonical form', () => {
    expect(renderReviewContext({ iteration: 0, planVersion: 1 })).toBe(
      'iteration=0, planVersion=1',
    );
  });

  it('omits planVersion when it is null (standalone /review obligations)', () => {
    expect(renderReviewContext({ iteration: 2, planVersion: null })).toBe('iteration=2');
  });

  it('omits planVersion when it is undefined', () => {
    expect(renderReviewContext({ iteration: 3 })).toBe('iteration=3');
  });

  it('output satisfies enforcement promptContainsValue for both keys (first attempt)', () => {
    const ctx = renderReviewContext({ iteration: 1, planVersion: 4 });
    const prompt = `Call the reviewer with a prompt that includes ${ctx}.`;
    expect(promptContainsValue(prompt, 'iteration', 1)).toBe(true);
    expect(promptContainsValue(prompt, 'version', 4)).toBe(true);
  });

  it('output round-trips through extractContentMeta', () => {
    const ctx = renderReviewContext({ iteration: 5, planVersion: 2 });
    const meta = extractContentMeta(`Context: ${ctx}.`);
    expect(meta).toEqual({ expectedIteration: 5, expectedPlanVersion: 2 });
  });

  it('is byte-identical regardless of which builder embeds it', () => {
    // Both pending-instruction.ts and host-task-policy.ts now call the same
    // serializer; a single source of truth guarantees identical substrings.
    const a = `includes the plan, ${renderReviewContext({ iteration: 0, planVersion: 1 })}.`;
    const b = `Context: ${renderReviewContext({ iteration: 0, planVersion: 1 })}.`;
    const shared = renderReviewContext({ iteration: 0, planVersion: 1 });
    expect(a).toContain(shared);
    expect(b).toContain(shared);
  });
});
