/**
 * @module evidence-validation.test
 * @description Tests for evidence-validation module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { ValidationResult } from './evidence-validation.js';
import { FIXED_TIME } from './evidence-test-constants.js';

describe('evidence-validation', () => {
  describe('HAPPY', () => {
    it('ValidationResult parses valid result with CheckId', () => {
      const result = {
        checkId: 'test_quality',
        passed: true,
        detail: 'All tests pass',
        executedAt: FIXED_TIME,
      };
      expect(ValidationResult.parse(result)).toEqual(result);
    });

    it('ValidationResult parses result with evidence metadata', () => {
      const result = {
        checkId: 'rollback_safety',
        passed: false,
        detail: 'No rollback plan found',
        executedAt: FIXED_TIME,
        evidenceType: 'manual_review' as const,
        evidenceSummary: 'Manual review of deployment plan',
      };
      expect(ValidationResult.parse(result)).toEqual(result);
    });

    it('ValidationResult parses result with command evidence', () => {
      const result = {
        checkId: 'test_quality',
        passed: true,
        detail: 'All 42 tests passed',
        executedAt: FIXED_TIME,
        evidenceType: 'command_output' as const,
        command: 'npm test',
        evidenceSummary: 'npm test output: 42 passed, 0 failed',
      };
      expect(ValidationResult.parse(result)).toEqual(result);
    });
  });

  describe('BAD', () => {
    it('ValidationResult rejects empty checkId', () => {
      expect(() =>
        ValidationResult.parse({
          checkId: '',
          passed: true,
          detail: 'ok',
          executedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('ValidationResult rejects invalid evidenceType', () => {
      expect(() =>
        ValidationResult.parse({
          checkId: 'test_quality',
          passed: true,
          detail: 'ok',
          executedAt: FIXED_TIME,
          evidenceType: 'invalid',
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('ValidationResult rejects missing executedAt', () => {
      expect(() =>
        ValidationResult.parse({
          checkId: 'test_quality',
          passed: true,
          detail: 'ok',
        }),
      ).toThrow();
    });
  });
});
