/**
 * @module integration/review/capture-retry.test
 * @description Classification matrix for native reviewer capture/binding
 * failures: retryable, terminal, and fail-closed unknown codes.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_RETRY_DIAGNOSTICS,
  MAX_RETRY_SCALAR_CHARS,
  RETRYABLE_REVIEWER_CAPTURE_CODES,
  TERMINAL_REVIEWER_CAPTURE_CODES,
  buildBindingRetryDiagnostics,
  buildCaptureFailureDiagnostics,
  buildCodeOnlyRetryDiagnostic,
  buildReviewerCaptureRetryOutput,
  classifyReviewerCaptureFailure,
  isKnownReviewerCaptureFailureCode,
} from './capture-retry.js';
import type { EvidenceLocationFailure } from '../observations/observation-binding.js';

describe('reviewer capture retry classification', () => {
  it('classifies every retryable code as retryable', () => {
    for (const code of RETRYABLE_REVIEWER_CAPTURE_CODES) {
      expect(classifyReviewerCaptureFailure(code), code).toEqual({ retryable: true, code });
      expect(isKnownReviewerCaptureFailureCode(code), code).toBe(true);
    }
  });

  it('classifies every terminal code as terminal', () => {
    for (const code of TERMINAL_REVIEWER_CAPTURE_CODES) {
      expect(classifyReviewerCaptureFailure(code), code).toEqual({ retryable: false, code });
      expect(isKnownReviewerCaptureFailureCode(code), code).toBe(true);
    }
  });

  it('fails an unknown code closed as terminal', () => {
    expect(classifyReviewerCaptureFailure('NOT_A_REVIEWER_CAPTURE_CODE')).toEqual({
      retryable: false,
      code: 'NOT_A_REVIEWER_CAPTURE_CODE',
    });
    expect(isKnownReviewerCaptureFailureCode('NOT_A_REVIEWER_CAPTURE_CODE')).toBe(false);
  });

  it('keeps the retryable and terminal partitions disjoint and total', () => {
    const retryable = new Set<string>(RETRYABLE_REVIEWER_CAPTURE_CODES);
    const terminal = new Set<string>(TERMINAL_REVIEWER_CAPTURE_CODES);
    expect(retryable.size).toBe(RETRYABLE_REVIEWER_CAPTURE_CODES.length);
    expect(terminal.size).toBe(TERMINAL_REVIEWER_CAPTURE_CODES.length);
    for (const code of retryable) expect(terminal.has(code), code).toBe(false);
    expect(retryable.size + terminal.size).toBe(31);
  });
});

describe('retry diagnostic DTOs', () => {
  it('builds a code-only diagnostic without any free reason', () => {
    expect(buildCodeOnlyRetryDiagnostic('HOST_STRUCTURED_OUTPUT_REQUIRED')).toEqual({
      code: 'HOST_STRUCTURED_OUTPUT_REQUIRED',
    });
  });

  it('maps every structured location failure to code, reasonKind, and scalar data', () => {
    const failures: readonly EvidenceLocationFailure[] = [
      { kind: 'no_attempt', path: 'docs/a.md' },
      { kind: 'revision_unavailable', revision: 'base' },
      { kind: 'unobserved', path: 'docs/b.md', revision: 'head' },
      { kind: 'binary_line_citation', path: 'docs/c.bin', revision: 'head' },
      { kind: 'line_out_of_range', path: 'docs/d.md', revision: 'base', line: 41, lineCount: 12 },
      {
        kind: 'end_line_out_of_range',
        path: 'docs/e.md',
        revision: 'head',
        endLine: 30,
        lineCount: 12,
      },
    ];
    expect(buildBindingRetryDiagnostics('REVIEW_EVIDENCE_NOT_OBSERVED', failures)).toEqual([
      {
        code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
        reasonKind: 'no_attempt',
        data: { path: 'docs/a.md' },
      },
      {
        code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
        reasonKind: 'revision_unavailable',
        data: { revision: 'base' },
      },
      {
        code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
        reasonKind: 'unobserved',
        data: { path: 'docs/b.md', revision: 'head' },
      },
      {
        code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
        reasonKind: 'binary_line_citation',
        data: { path: 'docs/c.bin', revision: 'head' },
      },
      {
        code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
        reasonKind: 'line_out_of_range',
        data: { path: 'docs/d.md', revision: 'base', line: '41', lineCount: '12' },
      },
      {
        code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
        reasonKind: 'end_line_out_of_range',
        data: { path: 'docs/e.md', revision: 'head', endLine: '30', lineCount: '12' },
      },
    ]);
  });

  it('reads structured failures from details for the observed-evidence code', () => {
    const diagnostics = buildCaptureFailureDiagnostics('REVIEW_EVIDENCE_NOT_OBSERVED', {
      obligationId: 'obligation-1',
      findingIndexes: [0],
      failures: [{ kind: 'unobserved', path: 'docs/a.md', revision: 'head' }],
    });
    expect(diagnostics).toEqual([
      {
        code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
        reasonKind: 'unobserved',
        data: { path: 'docs/a.md', revision: 'head' },
      },
    ]);
  });

  it('degrades malformed failure details to the code-only diagnostic', () => {
    for (const failures of [undefined, 'not-an-array', [null], [{ kind: 'unknown' }], [{}]]) {
      expect(
        buildCaptureFailureDiagnostics('REVIEW_EVIDENCE_NOT_OBSERVED', { failures }),
        JSON.stringify(failures),
      ).toEqual([{ code: 'REVIEW_EVIDENCE_NOT_OBSERVED' }]);
    }
  });

  it('uses the code-only diagnostic for non-observed-evidence failures', () => {
    expect(
      buildCaptureFailureDiagnostics('REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE', {
        failures: [{ kind: 'unobserved', path: 'docs/a.md', revision: 'head' }],
      }),
    ).toEqual([{ code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE' }]);
  });

  it('bounds diagnostic count and untrusted scalar length centrally', () => {
    const longPath = `docs/${'x'.repeat(MAX_RETRY_SCALAR_CHARS + 50)}.md`;
    const failures: EvidenceLocationFailure[] = Array.from(
      { length: MAX_RETRY_DIAGNOSTICS + 4 },
      () => ({ kind: 'unobserved', path: longPath, revision: 'head' }),
    );
    const diagnostics = buildBindingRetryDiagnostics('REVIEW_EVIDENCE_NOT_OBSERVED', failures);
    expect(diagnostics).toHaveLength(MAX_RETRY_DIAGNOSTICS);
    const path = diagnostics[0]?.data?.path ?? '';
    expect(path).toHaveLength(MAX_RETRY_SCALAR_CHARS + 1);
    expect(path.endsWith('…')).toBe(true);
    expect(path.startsWith('docs/')).toBe(true);
  });

  it('embeds structured diagnostics in the retry output without any free reason', () => {
    const output = JSON.parse(
      buildReviewerCaptureRetryOutput({
        code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
        obligationId: 'obligation-1',
        attemptId: 'attempt-2',
        diagnostics: [
          {
            code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
            reasonKind: 'unobserved',
            data: { path: 'docs/a.md', revision: 'head' },
          },
        ],
      }),
    ) as Record<string, unknown>;
    expect(output.reviewRetry).toMatchObject({
      code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
      obligationId: 'obligation-1',
      attemptId: 'attempt-2',
      retryable: true,
      diagnostics: [
        {
          code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
          reasonKind: 'unobserved',
          data: { path: 'docs/a.md', revision: 'head' },
        },
      ],
    });
    expect(JSON.stringify(output)).not.toContain('trusted retry context');
  });
});
