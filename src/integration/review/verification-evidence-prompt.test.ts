import { describe, expect, it } from 'vitest';

import {
  buildImplReviewPrompt,
  renderVerificationEvidence,
  type ReviewVerificationEvidenceItem,
} from './prompt-builders.js';
import type { DiscoveryReviewContext } from './discovery-context-prompt.js';

// Slice 1 (evidence-grounded review): the implementation reviewer prompt must
// carry FlowGuard-executed verification evidence bound to the current
// implementation digest, so the reviewer can falsify verification claims
// against ground truth. These tests pin the fail-closed rendering contract and
// the enforcement-token safety property.

const PASS_ITEM: ReviewVerificationEvidenceItem = {
  attemptId: '11111111-1111-4111-8111-111111111111',
  kind: 'test',
  command: 'npm test',
  passed: true,
  exitCode: 0,
  timedOut: false,
  executionMs: 4200,
  outputDigest: 'a'.repeat(64),
  detail: '42 passed',
  executedAt: '2026-01-01T00:00:00.000Z',
};

const FAIL_ITEM: ReviewVerificationEvidenceItem = {
  attemptId: '22222222-2222-4222-8222-222222222222',
  kind: 'typecheck',
  command: 'tsc --noEmit',
  passed: false,
  exitCode: 2,
  timedOut: false,
  executionMs: 1500,
  outputDigest: 'b'.repeat(64),
  detail: '1 error',
  executedAt: '2026-01-01T00:00:01.000Z',
};

const TIMEOUT_ITEM: ReviewVerificationEvidenceItem = {
  ...FAIL_ITEM,
  attemptId: '33333333-3333-4333-8333-333333333333',
  kind: 'build',
  command: 'npm run build',
  passed: false,
  exitCode: 124,
  timedOut: true,
  detail: 'killed after timeout',
};

const IMPL_OPTS = {
  changedFiles: ['src/foo.ts'],
  planText: 'the plan',
  ticketText: 'the ticket',
  iteration: 3,
  planVersion: 2,
  obligationId: '99999999-9999-4999-8999-999999999999',
  criteriaVersion: 'p40-v1',
  mandateDigest: 'mandate-digest',
  discoveryContext: {} as DiscoveryReviewContext,
};

describe('renderVerificationEvidence', () => {
  it('fails closed with an explicit NOT_VERIFIED line when no evidence is bound', () => {
    const lines = renderVerificationEvidence([]);
    const text = lines.join('\n');
    expect(text).toContain('## Verification Evidence (executed)');
    expect(text).toContain(
      'NOT_VERIFIED: no executed verification evidence is bound to the current implementation digest.',
    );
    // Must not silently omit the section.
    expect(lines.length).toBeGreaterThan(0);
  });

  it('renders a PASS row with the tamper-evident digest and command', () => {
    const text = renderVerificationEvidence([PASS_ITEM]).join('\n');
    expect(text).toContain('[PASS] kind=test exitCode=0 durationMs=4200');
    expect(text).toContain(`digest=${'a'.repeat(64)}`);
    expect(text).toContain('command: npm test');
    expect(text).toContain('detail: 42 passed');
  });

  it('renders a failing check as FAIL (not hidden)', () => {
    const text = renderVerificationEvidence([FAIL_ITEM]).join('\n');
    expect(text).toContain('[FAIL] kind=typecheck exitCode=2');
  });

  it('distinguishes a timed-out check from an ordinary failure', () => {
    const text = renderVerificationEvidence([TIMEOUT_ITEM]).join('\n');
    expect(text).toContain('[TIMED_OUT] kind=build');
    expect(text).not.toContain('[FAIL] kind=build');
  });

  it('renders every provided item', () => {
    const text = renderVerificationEvidence([PASS_ITEM, FAIL_ITEM]).join('\n');
    expect(text).toContain('kind=test');
    expect(text).toContain('kind=typecheck');
  });

  it('does not emit enforcement-breaking iteration/version+digit tokens', () => {
    // The L3 prompt-integrity matcher (promptContainsValue) keys on the tokens
    // "iteration"/"version" followed within a short window by a number. This
    // section must never introduce such a pair, or it could displace the real
    // context tokens. Assert the rendered evidence is free of them.
    const text = renderVerificationEvidence([PASS_ITEM, FAIL_ITEM, TIMEOUT_ITEM])
      .join('\n')
      .toLowerCase();
    expect(/iteration\D{0,30}\d/.test(text)).toBe(false);
    expect(/version\D{0,30}\d/.test(text)).toBe(false);
  });
});

describe('buildImplReviewPrompt — verification evidence section', () => {
  it('injects the evidence section when evidence is provided', () => {
    const prompt = buildImplReviewPrompt({
      ...IMPL_OPTS,
      verificationEvidence: [PASS_ITEM],
    });
    expect(prompt).toContain('## Verification Evidence (executed)');
    expect(prompt).toContain('[PASS] kind=test');
    expect(prompt).toContain('FlowGuard executed these checks itself');
  });

  it('injects the fail-closed NOT_VERIFIED evidence line when none is provided', () => {
    const prompt = buildImplReviewPrompt(IMPL_OPTS);
    expect(prompt).toContain('## Verification Evidence (executed)');
    expect(prompt).toContain(
      'NOT_VERIFIED: no executed verification evidence is bound to the current implementation digest.',
    );
  });

  it('keeps the real iteration/planVersion context tokens intact', () => {
    // Regression guard: the evidence section must not break the enforcement
    // context the prompt already carries.
    const prompt = buildImplReviewPrompt({ ...IMPL_OPTS, verificationEvidence: [PASS_ITEM] });
    expect(prompt).toContain('iteration=3');
    expect(prompt).toContain('planVersion=2');
  });
});
