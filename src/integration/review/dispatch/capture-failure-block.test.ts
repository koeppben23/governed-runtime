/**
 * @module integration/review/dispatch/capture-failure-block.test
 * @description Run-10 diagnostics regression: a native reviewer capture/binding
 * failure block must interpolate the REAL obligation id, must never leave a
 * cataloged template placeholder, and must carry the concrete location
 * failures as a bounded structured summary instead of a raw JSON blob.
 */

import { describe, expect, it } from 'vitest';
import { strictBlockedOutput } from '../../blocked-result.js';
import { captureFailureBlockDetail } from './capture-retry.js';
import type { PendingReviewRetryDiagnostic } from '../types.js';

const OBLIGATION_ID = '1005a47e-ef2b-415c-8a08-663673c527a3';

function formatBlock(detail: Record<string, string>) {
  return JSON.parse(strictBlockedOutput('REVIEW_EVIDENCE_NOT_OBSERVED', detail)) as {
    message: string;
    detail: Record<string, string>;
  };
}

describe('native capture-failure block detail (Run-10 diagnostics)', () => {
  const diagnostics: PendingReviewRetryDiagnostic[] = [
    {
      code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
      data: {
        observed: 'src/main/java/com/example/taskmanager/dto/TaskResponse.java@head',
        failureKind: 'unobserved',
      },
    },
  ];

  it('names the real obligation and leaves no unresolved template placeholder', () => {
    const block = formatBlock(
      captureFailureBlockDetail({
        obligationId: OBLIGATION_ID,
        reason: 'x'.repeat(4000),
        diagnostics,
      }),
    );

    expect(block.message).toContain(OBLIGATION_ID);
    expect(block.message).not.toContain('{obligationId}');
    expect(block.message).not.toContain('{reason}');
  });

  it('bounds the raw capture reason to its first line', () => {
    const detail = captureFailureBlockDetail({
      obligationId: OBLIGATION_ID,
      reason: `${'x'.repeat(4000)}\nsecond line must not leak`,
    });

    expect((detail.reason ?? '').length).toBeLessThanOrEqual(241);
    expect(detail.reason ?? '').not.toContain('second line');
  });

  it('summarizes the concrete location failures as bounded structured data', () => {
    const block = formatBlock(
      captureFailureBlockDetail({
        obligationId: OBLIGATION_ID,
        reason: 'capture contract failure',
        diagnostics,
      }),
    );

    expect(block.detail.diagnostics).toContain('TaskResponse.java@head');
    expect(block.detail.diagnostics).toContain('failureKind=unobserved');
  });

  it('bounds the diagnostics summary across entries', () => {
    const many: PendingReviewRetryDiagnostic[] = Array.from({ length: 5 }, (_, index) => ({
      code: `CODE_${index}`,
      data: { [`key${index}a`]: `value${index}a`, [`key${index}b`]: `value${index}b` },
    }));

    const detail = captureFailureBlockDetail({
      obligationId: OBLIGATION_ID,
      reason: 'capture contract failure',
      diagnostics: many,
    });

    expect(detail.diagnostics?.split(' | ')).toHaveLength(3);
  });

  it('works without diagnostics', () => {
    const detail = captureFailureBlockDetail({
      obligationId: OBLIGATION_ID,
      reason: 'terminal capture failure',
    });

    expect(detail).toEqual({ obligationId: OBLIGATION_ID, reason: 'terminal capture failure' });
  });

  it('interpolates the obligation id in the terminal binding-failure path', () => {
    const output = JSON.parse(
      strictBlockedOutput(
        'REVIEW_ATTEMPT_UNAVAILABLE',
        captureFailureBlockDetail({
          obligationId: OBLIGATION_ID,
          reason: 'Native reviewer evidence binding returned lineage_unavailable.',
        }),
      ),
    ) as { message: string };

    expect(output.message).toContain(OBLIGATION_ID);
    expect(output.message).not.toContain('{obligationId}');
    expect(output.message).not.toContain('{reason}');
  });

  it('summarizes structured contract diagnostics by path and constraint without raw values', () => {
    const detail = captureFailureBlockDetail({
      obligationId: OBLIGATION_ID,
      reason: 'ReviewerFindingsInput rejected (1 schema issue); first: majorRisks.0.category',
      diagnostics: [
        {
          code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
          reasonKind: 'invalid_value',
          data: {
            path: 'majorRisks.0.category',
            constraint: 'completeness|correctness|feasibility|risk|quality',
          },
        },
      ],
    });

    expect(detail.diagnostics).toContain('path=majorRisks.0.category');
    expect(detail.diagnostics).toContain(
      'constraint=completeness|correctness|feasibility|risk|quality',
    );
    expect(JSON.stringify(detail)).not.toContain('verification');
    expect(JSON.stringify(detail)).not.toContain('dangerous');
  });
});
