/**
 * @module integration/review/capture-retry.test
 * @description Classification matrix for native reviewer capture/binding
 * failures: retryable, terminal, and fail-closed unknown codes.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_RETRY_DIAGNOSTICS,
  MAX_RETRY_SCALAR_CHARS,
  MAX_STRUCTURED_CONTRACT_DIAGNOSTICS,
  RETRYABLE_REVIEWER_CAPTURE_CODES,
  TERMINAL_REVIEWER_CAPTURE_CODES,
  buildBindingRetryDiagnostics,
  buildCaptureFailureDiagnostics,
  buildCodeOnlyRetryDiagnostic,
  buildReviewerCaptureRetryOutput,
  buildStructuredFindingsContractDiagnostics,
  captureClosureAuditDiagnostics,
  classifyReviewerCaptureFailure,
  isKnownReviewerCaptureFailureCode,
  structuredFindingsContractReason,
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

  it('transports validator-derived finding positions for scope and anchor failures', () => {
    for (const code of [
      'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED',
      'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
      'REVIEW_EVIDENCE_LOCATION_ESCAPES_REPOSITORY',
      'REVIEW_EVIDENCE_LOCATION_INVALID',
      'REVIEW_REPOSITORY_REVISION_UNAVAILABLE',
    ]) {
      expect(
        buildCaptureFailureDiagnostics(code, {
          obligationId: 'obligation-1',
          findingIndex: '0, 2',
        }),
        code,
      ).toEqual([{ code, data: { findingIndex: '0, 2' } }]);
    }
  });

  it('normalizes transported finding positions to valid non-negative integers only', () => {
    expect(
      buildCaptureFailureDiagnostics('REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE', {
        findingIndex: ' 1 , 02 , x, -1, 3.5, 1e3, ',
      }),
    ).toEqual([
      { code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE', data: { findingIndex: '1, 2' } },
    ]);
  });

  it('degrades absent or malformed finding positions to the code-only diagnostic', () => {
    for (const details of [
      {},
      { findingIndex: '' },
      { findingIndex: 'not-a-position' },
      { findingIndex: '-1' },
      { findingIndex: 1 },
    ]) {
      expect(
        buildCaptureFailureDiagnostics('REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED', details),
        JSON.stringify(details),
      ).toEqual([{ code: 'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED' }]);
    }
  });

  it('names the offending challenge and its field path for a missing validation attempt', () => {
    expect(
      buildCaptureFailureDiagnostics('SUBAGENT_CHALLENGE_EVIDENCE_MISSING', {
        challengeIndex: 0,
        kind: 'implementation_challenge',
        reason: 'validation_attempt_missing',
        required: 'validation_attempt',
      }),
    ).toEqual([
      {
        code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
        reasonKind: 'validation_attempt_missing',
        data: { path: 'challenges.0.evidenceRefs', required: 'validation_attempt' },
      },
    ]);
  });

  it('carries the exact validated challenge position, never a reviewer-authored path', () => {
    expect(
      buildCaptureFailureDiagnostics('SUBAGENT_CHALLENGE_EVIDENCE_MISSING', {
        challengeIndex: 2,
        reason: 'evidence_mismatch',
      }),
    ).toEqual([
      {
        code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
        reasonKind: 'evidence_mismatch',
        data: { path: 'challenges.2.evidenceRefs' },
      },
    ]);
  });

  it('names the missing content evidence class for a passing challenge', () => {
    expect(
      buildCaptureFailureDiagnostics('SUBAGENT_CHALLENGE_EVIDENCE_MISSING', {
        challengeIndex: 1,
        reason: 'implementation_reference_missing',
        required: 'implementation',
      }),
    ).toEqual([
      {
        code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING',
        reasonKind: 'implementation_reference_missing',
        data: { path: 'challenges.1.evidenceRefs', required: 'implementation' },
      },
    ]);
  });

  it('degrades malformed or unknown challenge details to the code-only diagnostic', () => {
    for (const details of [
      {},
      { reason: 'validation_attempt_missing' },
      { challengeIndex: 0 },
      { challengeIndex: -1, reason: 'validation_attempt_missing' },
      { challengeIndex: 1.5, reason: 'validation_attempt_missing' },
      { challengeIndex: '0', reason: 'validation_attempt_missing' },
      { challengeIndex: 0, reason: 'reviewer_invented_reason' },
    ]) {
      expect(
        buildCaptureFailureDiagnostics('SUBAGENT_CHALLENGE_EVIDENCE_MISSING', details),
        JSON.stringify(details),
      ).toEqual([{ code: 'SUBAGENT_CHALLENGE_EVIDENCE_MISSING' }]);
    }
  });

  it('bounds the transported finding positions', () => {
    const csv = Array.from({ length: 12 }, (_unused, index) => String(index)).join(', ');
    const data = buildCaptureFailureDiagnostics('REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE', {
      findingIndex: csv,
    })[0]?.data;
    expect(data?.findingIndex).toBe('0, 1, 2, 3, 4, 5, 6, 7');
  });

  it('embeds finding positions in the retry output for the next reviewer attempt', () => {
    const output = JSON.parse(
      buildReviewerCaptureRetryOutput({
        code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
        obligationId: 'obligation-1',
        attemptId: 'attempt-2',
        diagnostics: [
          {
            code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
            data: { findingIndex: '0, 2' },
          },
        ],
      }),
    ) as { reviewRetry?: { diagnostics?: readonly unknown[] } };
    expect(output.reviewRetry?.diagnostics).toEqual([
      { code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE', data: { findingIndex: '0, 2' } },
    ]);
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

describe('structured findings contract diagnostics', () => {
  const CATEGORY_CONSTRAINT = 'completeness|correctness|feasibility|risk|quality';
  const ENUM_ISSUE = {
    code: 'invalid_value',
    values: ['completeness', 'correctness', 'feasibility', 'risk', 'quality'],
    path: ['majorRisks', 0, 'category'],
    message: 'Invalid option: expected one of …; received "dangerous"',
  };
  const TYPE_ISSUE = {
    expected: 'object',
    code: 'invalid_type',
    path: ['attestation'],
    message: 'Invalid input: expected object, received undefined',
  };

  it('reduces canonical schema issues to path, reason kind, and constraint', () => {
    expect(buildStructuredFindingsContractDiagnostics([ENUM_ISSUE, TYPE_ISSUE])).toEqual([
      {
        code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
        reasonKind: 'invalid_value',
        data: { path: 'majorRisks.0.category', constraint: CATEGORY_CONSTRAINT },
      },
      {
        code: 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION',
        reasonKind: 'invalid_type',
        data: { path: 'attestation', constraint: 'object' },
      },
    ]);
  });

  it('never carries the rejected value, raw schema messages, or payload content', () => {
    const serialized = JSON.stringify(buildStructuredFindingsContractDiagnostics([ENUM_ISSUE]));
    expect(serialized).not.toContain('dangerous');
    expect(serialized).not.toContain('received');
    expect(serialized).not.toContain('Invalid option');
    expect(serialized).not.toContain('message');
    expect(serialized).not.toContain('values');
  });

  it('caps diagnostics at the primary failures and stays safe for malformed issues', () => {
    const many = Array.from(
      { length: MAX_STRUCTURED_CONTRACT_DIAGNOSTICS + 4 },
      (_unused, index) => ({
        code: 'invalid_value',
        values: ['a', 'b'],
        path: ['majorRisks', index, 'category'],
      }),
    );
    const bounded = buildStructuredFindingsContractDiagnostics(many);
    expect(bounded).toHaveLength(MAX_STRUCTURED_CONTRACT_DIAGNOSTICS);
    expect(bounded[0]?.data?.path).toBe('majorRisks.0.category');
    expect(buildStructuredFindingsContractDiagnostics([null, 'x', {}, { code: '' }])).toEqual([]);
  });

  it('bounds long paths and constraints centrally', () => {
    const diagnostics = buildStructuredFindingsContractDiagnostics([
      {
        code: 'invalid_value',
        values: Array.from({ length: 60 }, (_unused, index) => `value-${String(index)}`),
        path: ['x'.repeat(MAX_RETRY_SCALAR_CHARS + 40)],
      },
    ]);
    const data = diagnostics[0]?.data ?? {};
    expect(data.path).toHaveLength(MAX_RETRY_SCALAR_CHARS + 1);
    expect(data.constraint).toHaveLength(MAX_RETRY_SCALAR_CHARS + 1);
  });

  it('leads the bounded block reason with the primary offending field', () => {
    const reason = structuredFindingsContractReason([ENUM_ISSUE, TYPE_ISSUE]);
    expect(reason).toBe(
      `ReviewerFindingsInput rejected (2 schema issues); first: majorRisks.0.category — expected ${CATEGORY_CONSTRAINT}`,
    );
    expect(reason.length).toBeLessThan(240);
    expect(reason).not.toContain('dangerous');
  });

  it('degrades safely when no issue detail is parseable', () => {
    expect(structuredFindingsContractReason([null])).toBe(
      'ReviewerFindingsInput rejected (1 schema issue); no structured issue detail available',
    );
  });

  it('falls back to the expected type for empty or mixed value lists', () => {
    const empty = buildStructuredFindingsContractDiagnostics([
      { code: 'invalid_value', values: [], expected: 'string', path: ['a'] },
    ]);
    expect(empty[0]?.data).toEqual({ path: 'a', constraint: 'string' });
    const mixed = buildStructuredFindingsContractDiagnostics([
      { code: 'invalid_value', values: ['a', { nested: true }], expected: 'string', path: ['b'] },
    ]);
    expect(mixed[0]?.data).toEqual({ path: 'b', constraint: 'string' });
  });

  it('omits the constraint for an empty or non-string expected value', () => {
    const empty = buildStructuredFindingsContractDiagnostics([
      { code: 'invalid_type', expected: '', path: ['a'] },
    ]);
    expect(empty[0]?.data).toEqual({ path: 'a' });
    const nonString = buildStructuredFindingsContractDiagnostics([
      { code: 'invalid_type', expected: ['x'], path: ['b'] },
    ]);
    expect(nonString[0]?.data).toEqual({ path: 'b' });
  });

  it('projects the closure audit view with caps and defaults', () => {
    const bounded = captureClosureAuditDiagnostics([
      { code: 'CODE_A', reasonKind: 'kind_a', data: { path: 'a', constraint: 'c' } },
      { code: 'CODE_B', data: { path: 'b' } },
      { code: 'CODE_C', data: { path: 'c' } },
      { code: 'CODE_D', data: { path: 'd' } },
    ]);
    expect(bounded).toEqual([
      { reasonKind: 'kind_a', path: 'a', constraint: 'c' },
      { reasonKind: 'CODE_B', path: 'b' },
      { reasonKind: 'CODE_C', path: 'c' },
    ]);
    expect(captureClosureAuditDiagnostics([{ code: 'CODE_ONLY' }])).toEqual([
      { reasonKind: 'CODE_ONLY', path: '' },
    ]);
  });

  it('projects the closure audit view without raw values', () => {
    const audit = captureClosureAuditDiagnostics(
      buildStructuredFindingsContractDiagnostics([ENUM_ISSUE]),
    );
    expect(audit).toEqual([
      {
        reasonKind: 'invalid_value',
        path: 'majorRisks.0.category',
        constraint: CATEGORY_CONSTRAINT,
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain('dangerous');
  });
});
