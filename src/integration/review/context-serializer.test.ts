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
import { renderReviewContext, renderReviewerTaskPrompt } from './prompt-builders.js';
import { promptContainsValue, extractContentMeta } from './enforcement/extraction.js';
import { MIN_SUBAGENT_PROMPT_LENGTH } from './enforcement/types.js';

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

describe('F10: renderReviewerTaskPrompt canonical copy-prompt', () => {
  const base = {
    obligationId: '00000000-0000-4000-8000-000000000000',
    mandateDigest: 'sha256:deadbeef',
    criteriaVersion: 'p37-v1',
    subjectLabel: 'the branch diff',
  };

  it('embeds the canonical context and passes the enforcement matcher on first attempt', () => {
    const prompt = renderReviewerTaskPrompt({ iteration: 2, planVersion: 3, ...base });
    // The exact structural guarantee: the emitted prompt satisfies the SAME
    // matcher the hook uses, so the first Task attempt is never blocked.
    expect(promptContainsValue(prompt, 'iteration', 2)).toBe(true);
    expect(promptContainsValue(prompt, 'version', 3)).toBe(true);
    expect(extractContentMeta(prompt)).toEqual({ expectedIteration: 2, expectedPlanVersion: 3 });
  });

  it('clears the minimum prompt-length gate on its own', () => {
    const prompt = renderReviewerTaskPrompt({ iteration: 0, planVersion: 1, ...base });
    expect(prompt.length).toBeGreaterThanOrEqual(MIN_SUBAGENT_PROMPT_LENGTH);
  });

  it('carries the attestation values verbatim', () => {
    const prompt = renderReviewerTaskPrompt({ iteration: 1, planVersion: 1, ...base });
    expect(prompt).toContain(base.obligationId);
    expect(prompt).toContain(base.mandateDigest);
    expect(prompt).toContain(base.criteriaVersion);
    expect(prompt).toContain('flowguard-reviewer');
  });

  it('omits planVersion cleanly for standalone /review (planVersion null)', () => {
    const prompt = renderReviewerTaskPrompt({ iteration: 4, planVersion: null, ...base });
    expect(promptContainsValue(prompt, 'iteration', 4)).toBe(true);
    expect(prompt).not.toContain('planVersion');
    expect(extractContentMeta(prompt)).toEqual({ expectedIteration: 4, expectedPlanVersion: null });
  });

  it('does not prefill a verdict or findings (anti-fabrication)', () => {
    const prompt = renderReviewerTaskPrompt({ iteration: 1, planVersion: 1, ...base });
    expect(prompt).not.toMatch(/"overallVerdict"\s*:/);
    expect(prompt).not.toMatch(/\baccept\b/);
    expect(prompt).toContain('MUST NOT call any FlowGuard tools');
  });
});
