/**
 * @module architecture/enforcement-invariants-guard
 * @description Architecture guard: enforcement invariants that keep the
 * review contract closed. Verifies that schema_invalid reviewer output does
 * NOT deadlock the review, that verdict guessing is prevented, and that
 * reviewerUnavailable misuse is caught.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

describe('enforcement contract invariants', () => {
  it('verdict guessing is impossible without a recorded structured invocation', () => {
    const content = readFileSync(
      join(SRC_ROOT, 'integration/review/enforcement/enforcement.ts'),
      'utf8',
    );
    // Only a host-observed structured invocation authorizes a verdict; no
    // submitted argument payload can satisfy the gate.
    expect(content).toContain('SUBAGENT_REVIEW_NOT_INVOKED');
    expect(content).toContain('sdk_session_prompt');
    expect(content).not.toContain('args.reviewFindings');
  });

  it('verdict enforcement authorizes only host-observed structured evidence', () => {
    // The verdict gate must recognize the host-observed structured invocation;
    // no submitted findings can authorize a verdict on their own.
    const content = readFileSync(
      join(SRC_ROOT, 'integration/review/enforcement/enforcement.ts'),
      'utf8',
    );
    expect(content).toContain('sdk_session_prompt');
    expect(content).toContain('SUBAGENT_REVIEW_NOT_INVOKED');
  });

  it('review-validation.ts rejects reviewerUnavailable when invocations exist', () => {
    const content = readFileSync(join(SRC_ROOT, 'integration/tools/review-validation.ts'), 'utf8');
    // Must check for existing invocations before accepting reviewerUnavailable
    expect(content).toContain('checkReviewerUnavailableMisuse');
    expect(content).toContain('INVALID_REVIEW_TOOL_SEQUENCE');
    expect(content).toContain('sdk_session_prompt');
    expect(content).toContain('invocationMode');
  });

  it('enforcement holds no transient task-capture state', () => {
    // Reviewer execution authority is the host-observed structured SDK
    // invocation persisted in review assurance; the transient pending review
    // tracks only signal identity and must never record captures itself.
    const content = readFileSync(
      join(SRC_ROOT, 'integration/review/enforcement/enforcement.ts'),
      'utf8',
    );
    expect(content).not.toContain('recordPluginReview');
    expect(content).not.toContain('subagentCalled');
    expect(content).not.toContain('capturedFindings');
    expect(content).toContain('sdk_session_prompt');
  });

  it('removes the obsolete host-task prompt authority', () => {
    expect(existsSync(join(SRC_ROOT, 'integration/review/host-task-policy.ts'))).toBe(false);
  });

  it('anchor contract is typed per review subject kind', () => {
    const content = readFileSync(join(SRC_ROOT, 'state/review-continuation.ts'), 'utf8');
    expect(content).toContain('buildAnchorContract');
    expect(content).toContain('ReviewAnchorContract');
    expect(content).toContain("kind: 'repository_change'");
    expect(content).toContain("kind: 'content'");
  });
});
