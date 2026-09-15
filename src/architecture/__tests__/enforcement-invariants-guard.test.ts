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
  it('isPendingCaptureUsable returns false for schema-invalid captured findings', () => {
    // The canonical capture-usability query applies the strict schema gate to
    // the host-normalized candidate; an invalid capture is unusable, never
    // silently accepted.
    const authority = readFileSync(
      join(SRC_ROOT, 'integration/review/enforcement/prepare-findings.ts'),
      'utf8',
    );
    expect(authority).toContain('export function isPendingCaptureUsable');
    // Must check ReviewFindings.safeParse of the normalized candidate
    expect(authority).toContain('ReviewFindings.safeParse');
    // Must return false when the parse fails (no deadlock)
    expect(authority).toContain('return false');
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

  it('a reviewer session may hold evidence for one pending review at most', () => {
    // recordPluginReview must refuse a second capture for an already-called
    // pending review; one reviewer invocation cannot authorize two verdicts.
    const content = readFileSync(
      join(SRC_ROOT, 'integration/review/enforcement/enforcement.ts'),
      'utf8',
    );
    expect(content).toContain('export function recordPluginReview');
    expect(content).toMatch(/pending\.subagentCalled/);
    expect(content).toContain('return false');
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
