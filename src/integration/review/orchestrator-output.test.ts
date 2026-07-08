/**
 * @module integration/review/orchestrator-output.test
 * @description Unit coverage for the output-mutation helpers the orchestrator
 * re-exports. These inject plugin review findings into tool output; they are
 * mutation-scoped, so every guard, optional field, and emitted marker is
 * asserted here to kill mutants that would otherwise survive.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect } from 'vitest';
import { buildMutatedOutput, buildReviewContentMutatedOutput } from './orchestrator-output.js';
import { REVIEW_COMPLETED_PREFIX } from './orchestrator-constants.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';

function reviewerResult(overrides: Record<string, unknown> = {}) {
  return {
    findings: { overallVerdict: 'accept', blockingIssues: [] },
    sessionId: 'child-session-1',
    reviewOutputMode: 'structured',
    structuredOutputUsed: true,
    reviewAssuranceLevel: 'native_subagent_attested',
    ...overrides,
  } as Parameters<typeof buildMutatedOutput>[1];
}

const BASE_OUTPUT = JSON.stringify({ phase: 'PLAN', next: 'OLD_NEXT', hasPlan: true });

describe('buildMutatedOutput', () => {
  it('HAPPY: injects findings, session id, and the COMPLETED next marker', () => {
    const out = buildMutatedOutput(BASE_OUTPUT, reviewerResult());
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.next.startsWith(REVIEW_COMPLETED_PREFIX)).toBe(true);
    expect(parsed.next).toContain(REVIEWER_SUBAGENT_TYPE);
    expect(parsed.pluginReviewFindings).toEqual({ overallVerdict: 'accept', blockingIssues: [] });
    expect(parsed._pluginReviewSessionId).toBe('child-session-1');
    expect(parsed.pluginReviewOutput).toEqual({
      reviewOutputMode: 'structured',
      structuredOutputUsed: true,
      reviewAssuranceLevel: 'native_subagent_attested',
    });
  });

  it('HAPPY: preserves unrelated fields from the original output', () => {
    const parsed = JSON.parse(buildMutatedOutput(BASE_OUTPUT, reviewerResult())!);
    expect(parsed.phase).toBe('PLAN');
    expect(parsed.hasPlan).toBe(true);
  });

  it('BAD: returns null when reviewer findings are absent', () => {
    expect(buildMutatedOutput(BASE_OUTPUT, reviewerResult({ findings: null }))).toBeNull();
    expect(buildMutatedOutput(BASE_OUTPUT, reviewerResult({ findings: undefined }))).toBeNull();
  });

  it('BAD: returns null when the original output is not parseable', () => {
    expect(buildMutatedOutput('not json {', reviewerResult())).toBeNull();
  });

  it('BAD: returns null when the original output parses to an array', () => {
    expect(buildMutatedOutput(JSON.stringify([{ next: 'x' }]), reviewerResult())).toBeNull();
  });

  it('EDGE: includes extractionMethod only when provided', () => {
    const withField = JSON.parse(
      buildMutatedOutput(BASE_OUTPUT, reviewerResult({ extractionMethod: 'json_fallback' }))!,
    );
    expect(withField.pluginReviewOutput.extractionMethod).toBe('json_fallback');

    const withoutField = JSON.parse(buildMutatedOutput(BASE_OUTPUT, reviewerResult())!);
    expect('extractionMethod' in withoutField.pluginReviewOutput).toBe(false);
  });

  it('EDGE: includes modelCapabilityError only when provided', () => {
    const withField = JSON.parse(
      buildMutatedOutput(BASE_OUTPUT, reviewerResult({ modelCapabilityError: 'no_structured' }))!,
    );
    expect(withField.pluginReviewOutput.modelCapabilityError).toBe('no_structured');

    const withoutField = JSON.parse(buildMutatedOutput(BASE_OUTPUT, reviewerResult())!);
    expect('modelCapabilityError' in withoutField.pluginReviewOutput).toBe(false);
  });
});

describe('buildReviewContentMutatedOutput', () => {
  it('HAPPY: injects findings and the PLUGIN_REVIEW_COMPLETED content marker', () => {
    const out = buildReviewContentMutatedOutput(BASE_OUTPUT, reviewerResult());
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.next.startsWith('PLUGIN_REVIEW_COMPLETED')).toBe(true);
    expect(parsed.next).toContain('flowguard_review');
    expect(parsed.next).toContain(REVIEWER_SUBAGENT_TYPE);
    expect(parsed.pluginReviewFindings).toEqual({ overallVerdict: 'accept', blockingIssues: [] });
    expect(parsed._pluginReviewSessionId).toBe('child-session-1');
  });

  it('BAD: returns null when reviewer findings are absent', () => {
    expect(
      buildReviewContentMutatedOutput(BASE_OUTPUT, reviewerResult({ findings: null })),
    ).toBeNull();
  });

  it('BAD: returns null when the original output is not parseable', () => {
    expect(buildReviewContentMutatedOutput('}{ broken', reviewerResult())).toBeNull();
  });

  it('BAD: returns null when the original output parses to an array', () => {
    expect(buildReviewContentMutatedOutput(JSON.stringify(['x']), reviewerResult())).toBeNull();
  });

  it('EDGE: optional diagnostics fields are gated the same way', () => {
    const both = JSON.parse(
      buildReviewContentMutatedOutput(
        BASE_OUTPUT,
        reviewerResult({ extractionMethod: 'm', modelCapabilityError: 'e' }),
      )!,
    );
    expect(both.pluginReviewOutput.extractionMethod).toBe('m');
    expect(both.pluginReviewOutput.modelCapabilityError).toBe('e');

    const neither = JSON.parse(buildReviewContentMutatedOutput(BASE_OUTPUT, reviewerResult())!);
    expect('extractionMethod' in neither.pluginReviewOutput).toBe(false);
    expect('modelCapabilityError' in neither.pluginReviewOutput).toBe(false);
  });
});
