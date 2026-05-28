/**
 * @module evidence-validation.test
 * @description Tests for evidence-validation module (v2 execution-evidence schema).
 *
 * v2: ValidationResult requires cryptographic execution evidence:
 * - kind, command, exitCode, executionMs, outputDigest, timedOut
 *
 * @test-policy HAPPY, BAD, CORNER
 */
import { describe, it, expect } from 'vitest';
import { ValidationResult } from './evidence-validation.js';
import { FIXED_TIME } from './evidence-test-constants.js';

const VALID_DIGEST = 'a'.repeat(64);

describe('evidence-validation', () => {
  describe('HAPPY', () => {
    it('ValidationResult parses valid execution-evidence result', () => {
      const result = {
        checkId: 'test',
        passed: true,
        detail: 'All tests pass',
        executedAt: FIXED_TIME,
        kind: 'test' as const,
        command: 'npm test',
        exitCode: 0,
        executionMs: 1500,
        outputDigest: VALID_DIGEST,
        timedOut: false,
      };
      expect(ValidationResult.parse(result)).toEqual(result);
    });

    it('ValidationResult parses failed check with non-zero exit code', () => {
      const result = {
        checkId: 'lint',
        passed: false,
        detail: 'ESLint found 3 errors',
        executedAt: FIXED_TIME,
        kind: 'lint' as const,
        command: 'npm run lint',
        exitCode: 1,
        executionMs: 800,
        outputDigest: VALID_DIGEST,
        timedOut: false,
      };
      expect(ValidationResult.parse(result)).toEqual(result);
    });

    it('ValidationResult parses timed-out result', () => {
      const result = {
        checkId: 'test',
        passed: false,
        detail: 'Test execution timed out',
        executedAt: FIXED_TIME,
        kind: 'test' as const,
        command: 'npm test',
        exitCode: 124,
        executionMs: 300000,
        outputDigest: VALID_DIGEST,
        timedOut: true,
      };
      expect(ValidationResult.parse(result)).toEqual(result);
    });

    it('ValidationResult accepts all valid kinds', () => {
      const kinds = [
        'lint',
        'typecheck',
        'test',
        'build',
        'format',
        'security',
        'coverage',
      ] as const;
      for (const kind of kinds) {
        const result = {
          checkId: kind,
          passed: true,
          detail: `${kind} passed`,
          executedAt: FIXED_TIME,
          kind,
          command: `npm run ${kind}`,
          exitCode: 0,
          executionMs: 100,
          outputDigest: VALID_DIGEST,
          timedOut: false,
        };
        expect(() => ValidationResult.parse(result)).not.toThrow();
      }
    });
  });

  describe('BAD', () => {
    it('rejects empty checkId', () => {
      expect(() =>
        ValidationResult.parse({
          checkId: '',
          passed: true,
          detail: 'ok',
          executedAt: FIXED_TIME,
          kind: 'test',
          command: 'npm test',
          exitCode: 0,
          executionMs: 100,
          outputDigest: VALID_DIGEST,
          timedOut: false,
        }),
      ).toThrow();
    });

    it('rejects invalid kind', () => {
      expect(() =>
        ValidationResult.parse({
          checkId: 'test',
          passed: true,
          detail: 'ok',
          executedAt: FIXED_TIME,
          kind: 'invalid_kind',
          command: 'npm test',
          exitCode: 0,
          executionMs: 100,
          outputDigest: VALID_DIGEST,
          timedOut: false,
        }),
      ).toThrow();
    });

    it('rejects invalid outputDigest (not 64 hex chars)', () => {
      expect(() =>
        ValidationResult.parse({
          checkId: 'test',
          passed: true,
          detail: 'ok',
          executedAt: FIXED_TIME,
          kind: 'test',
          command: 'npm test',
          exitCode: 0,
          executionMs: 100,
          outputDigest: 'too-short',
          timedOut: false,
        }),
      ).toThrow();
    });

    it('rejects empty command', () => {
      expect(() =>
        ValidationResult.parse({
          checkId: 'test',
          passed: true,
          detail: 'ok',
          executedAt: FIXED_TIME,
          kind: 'test',
          command: '',
          exitCode: 0,
          executionMs: 100,
          outputDigest: VALID_DIGEST,
          timedOut: false,
        }),
      ).toThrow();
    });

    it('rejects negative executionMs', () => {
      expect(() =>
        ValidationResult.parse({
          checkId: 'test',
          passed: true,
          detail: 'ok',
          executedAt: FIXED_TIME,
          kind: 'test',
          command: 'npm test',
          exitCode: 0,
          executionMs: -1,
          outputDigest: VALID_DIGEST,
          timedOut: false,
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('rejects missing required fields', () => {
      // Missing kind, command, exitCode, executionMs, outputDigest, timedOut
      expect(() =>
        ValidationResult.parse({
          checkId: 'test',
          passed: true,
          detail: 'ok',
          executedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('rejects missing executedAt', () => {
      expect(() =>
        ValidationResult.parse({
          checkId: 'test',
          passed: true,
          detail: 'ok',
          kind: 'test',
          command: 'npm test',
          exitCode: 0,
          executionMs: 100,
          outputDigest: VALID_DIGEST,
          timedOut: false,
        }),
      ).toThrow();
    });
  });
});
