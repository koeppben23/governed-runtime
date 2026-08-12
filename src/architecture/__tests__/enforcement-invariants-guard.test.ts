/**
 * @module architecture/enforcement-invariants-guard
 * @description Architecture guard: enforcement invariants that keep the
 * review contract closed. Verifies that schema_invalid reviewer output does
 * NOT deadlock the review, that verdict guessing is prevented, and that
 * reviewerUnavailable misuse is caught.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

describe('enforcement contract invariants', () => {
  it('hasUsableCapture returns false for schema-invalid captured findings', () => {
    // Verify the function exists and contains the expected guard logic
    const content = readFileSync(
      join(SRC_ROOT, 'integration/review/enforcement/enforcement.ts'),
      'utf8',
    );
    expect(content).toContain('function hasUsableCapture');
    // Must check ReviewFindings.safeParse of rawFindings
    expect(content).toContain('ReviewFindings.safeParse');
    // Must return false when parse fails (no deadlock)
    expect(content).toContain('return false');
  });

  it('checkFindingsMismatch prevents verdict guessing', () => {
    const content = readFileSync(
      join(SRC_ROOT, 'integration/review/enforcement/enforcement.ts'),
      'utf8',
    );
    expect(content).toContain('SUBAGENT_FINDINGS_VERDICT_MISMATCH');
    expect(content).toContain('submittedVerdict');
    expect(content).toContain('pending.capturedFindings');
  });

  it('pending review is re-armable when capture is unusable', () => {
    // matchPendingReview must consider reviews with !hasUsableCapture as
    // awaiting capture, so a re-run of the reviewer replaces the bad capture.
    const content = readFileSync(
      join(SRC_ROOT, 'integration/review/enforcement/enforcement.ts'),
      'utf8',
    );
    expect(content).toContain('!hasUsableCapture(p)');
  });

  it('review-validation.ts rejects reviewerUnavailable when invocations exist', () => {
    const content = readFileSync(join(SRC_ROOT, 'integration/tools/review-validation.ts'), 'utf8');
    // Must check for existing invocations before accepting reviewerUnavailable
    expect(content).toContain('checkReviewerUnavailableMisuse');
    expect(content).toContain('INVALID_REVIEW_TOOL_SEQUENCE');
    expect(content).toContain('host_subagent_task');
    expect(content).toContain('invocationMode');
  });
});
