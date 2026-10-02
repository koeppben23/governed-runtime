/**
 * @module integration/review/capture-retry.test
 * @description Classification matrix for native reviewer capture/binding
 * failures: retryable, terminal, and fail-closed unknown codes.
 */

import { describe, expect, it } from 'vitest';
import {
  RETRYABLE_REVIEWER_CAPTURE_CODES,
  TERMINAL_REVIEWER_CAPTURE_CODES,
  classifyReviewerCaptureFailure,
  isKnownReviewerCaptureFailureCode,
} from './capture-retry.js';

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
