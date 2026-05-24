/**
 * @module evidence-error.test
 * @description Tests for evidence-error module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { ErrorInfo } from './evidence-error.js';
import { FIXED_TIME } from './evidence-test-constants.js';

describe('evidence-error', () => {
  describe('HAPPY', () => {
    it('ErrorInfo parses valid error', () => {
      const err = {
        code: 'TOOL_ERROR',
        message: 'Something went wrong',
        recoveryHint: 'Retry the operation',
        occurredAt: FIXED_TIME,
      };
      expect(ErrorInfo.parse(err)).toEqual(err);
    });
  });

  describe('BAD', () => {
    it('ErrorInfo rejects empty code', () => {
      expect(() =>
        ErrorInfo.parse({
          code: '',
          message: 'msg',
          recoveryHint: 'retry',
          occurredAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('ErrorInfo rejects empty message', () => {
      expect(() =>
        ErrorInfo.parse({
          code: 'TEST',
          message: '',
          recoveryHint: 'retry',
          occurredAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('ErrorInfo rejects missing recoveryHint', () => {
      expect(() =>
        ErrorInfo.parse({
          code: 'TEST',
          message: 'msg',
          occurredAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });
});
