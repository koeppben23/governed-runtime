import { describe, it, expect } from 'vitest';
import { classifyToolCallMode, toolCallFlags, type ToolFamily } from './review-validation-mode.js';

/**
 * @module integration/tools/review-validation-mode.test
 * @description The single canonical multi-mode validator (#499). These tests pin
 * the discriminated-mode classification and the per-family invalid codes, and
 * include a symmetry matrix so the three tool families cannot drift apart again.
 */

const findings = { overallVerdict: 'accept' as const };

describe('toolCallFlags', () => {
  it('is null-tolerant for absent optional fields', () => {
    const f = toolCallFlags({
      text: undefined,
      reviewVerdict: undefined,
      reviewFindings: null as unknown,
      reviewerUnavailable: undefined,
    });
    expect(f).toEqual({
      hasText: false,
      hasVerdict: false,
      hasFindings: false,
      hasReviewerUnavailable: false,
    });
  });

  it('treats whitespace-only text as absent', () => {
    expect(toolCallFlags({ text: '   ' }).hasText).toBe(false);
    expect(toolCallFlags({ text: '## Plan' }).hasText).toBe(true);
  });
});

describe('classifyToolCallMode — valid modes (all families)', () => {
  const families: ToolFamily[] = ['plan', 'architecture', 'implement'];
  for (const family of families) {
    it(`${family}: no verdict => initial_submission`, () => {
      expect(classifyToolCallMode(family, {}).kind).toBe('initial_submission');
    });
    it(`${family}: verdict=changes_requested => revision`, () => {
      expect(classifyToolCallMode(family, { reviewVerdict: 'changes_requested' }).kind).toBe(
        'revision',
      );
    });
    it(`${family}: verdict=accept => approval`, () => {
      expect(classifyToolCallMode(family, { reviewVerdict: 'accept' }).kind).toBe('approval');
    });
  }

  it('plan/architecture: text + verdict=changes_requested is a valid revision (never blocked)', () => {
    expect(
      classifyToolCallMode('plan', { text: '## Revised', reviewVerdict: 'changes_requested' }).kind,
    ).toBe('revision');
    expect(
      classifyToolCallMode('architecture', {
        text: '## Revised',
        reviewVerdict: 'changes_requested',
      }).kind,
    ).toBe('revision');
  });
});

describe('classifyToolCallMode — invalid shapes, canonical per-family codes', () => {
  it('plan: text + verdict=accept => PLAN_APPROVE_WITH_TEXT (with mirrored verdict param)', () => {
    const mode = classifyToolCallMode('plan', { text: '## P', reviewVerdict: 'accept' });
    expect(mode).toMatchObject({
      kind: 'invalid',
      code: 'PLAN_APPROVE_WITH_TEXT',
      params: { receivedVerdict: 'accept' },
    });
  });

  it('architecture: text + verdict=accept => ADR_APPROVE_WITH_TEXT (gap closed, mirrored)', () => {
    const mode = classifyToolCallMode('architecture', { text: '## ADR', reviewVerdict: 'accept' });
    expect(mode).toMatchObject({
      kind: 'invalid',
      code: 'ADR_APPROVE_WITH_TEXT',
      params: { receivedVerdict: 'accept' },
    });
  });

  it('implement: has no text payload, so approve-with-text is structurally impossible', () => {
    // implement never carries text; verdict=accept alone is a valid approval shape.
    expect(classifyToolCallMode('implement', { reviewVerdict: 'accept' }).kind).toBe('approval');
  });

  it('plan: text + findings + no verdict => PLAN_SUBMISSION_MIXED_INPUTS', () => {
    expect(classifyToolCallMode('plan', { text: '## P', reviewFindings: findings })).toMatchObject({
      kind: 'invalid',
      code: 'PLAN_SUBMISSION_MIXED_INPUTS',
    });
  });

  it('architecture: findings + no verdict => ADR_FINDINGS_WITHOUT_VERDICT (gap closed)', () => {
    expect(
      classifyToolCallMode('architecture', { text: '## ADR', reviewFindings: findings }),
    ).toMatchObject({ kind: 'invalid', code: 'ADR_FINDINGS_WITHOUT_VERDICT' });
    expect(classifyToolCallMode('architecture', { reviewFindings: findings })).toMatchObject({
      kind: 'invalid',
      code: 'ADR_FINDINGS_WITHOUT_VERDICT',
    });
  });

  it('implement: findings + no verdict => INVALID_IMPLEMENT_TOOL_SEQUENCE', () => {
    expect(classifyToolCallMode('implement', { reviewFindings: findings })).toMatchObject({
      kind: 'invalid',
      code: 'INVALID_IMPLEMENT_TOOL_SEQUENCE',
    });
  });

  it('plan: bare findings + no verdict (no text) is deferred to the state layer (not a pure-shape fault)', () => {
    // plan distinguishes PLAN_SUBMISSION_REQUIRED vs PLAN_FINDINGS_WITHOUT_VERDICT
    // based on state, so the pure-shape classifier must NOT reject it.
    expect(classifyToolCallMode('plan', { reviewFindings: findings }).kind).toBe(
      'initial_submission',
    );
  });

  it('plan: reviewerUnavailable mixed into a text submission => INVALID_PLAN_TOOL_SEQUENCE', () => {
    expect(classifyToolCallMode('plan', { text: '## P', reviewerUnavailable: true })).toMatchObject(
      { kind: 'invalid', code: 'INVALID_PLAN_TOOL_SEQUENCE' },
    );
  });

  it('plan: reviewerUnavailable WITHOUT text is not a shape fault (historical rule)', () => {
    expect(classifyToolCallMode('plan', { reviewerUnavailable: true }).kind).toBe(
      'initial_submission',
    );
  });

  it('architecture: reviewerUnavailable + submission => INVALID_ARCHITECTURE_TOOL_SEQUENCE (dead code now wired)', () => {
    expect(classifyToolCallMode('architecture', { reviewerUnavailable: true })).toMatchObject({
      kind: 'invalid',
      code: 'INVALID_ARCHITECTURE_TOOL_SEQUENCE',
    });
  });

  it('implement: reviewerUnavailable + record mode => INVALID_IMPLEMENT_TOOL_SEQUENCE (gap closed)', () => {
    expect(classifyToolCallMode('implement', { reviewerUnavailable: true })).toMatchObject({
      kind: 'invalid',
      code: 'INVALID_IMPLEMENT_TOOL_SEQUENCE',
    });
  });
});
