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
import { ValidationAttempt, ValidationResult, isExecutionError } from './evidence-validation.js';
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
        outcome: 'supported' as const,
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
        outcome: 'inconclusive' as const,
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
        outcome: 'blocked' as const,
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
          outcome: 'supported' as const,
        };
        expect(() => ValidationResult.parse(result)).not.toThrow();
      }
    });

    it('ValidationAttempt binds a baseline result to the plan digest', () => {
      const result = ValidationAttempt.parse({
        attemptId: '00000000-0000-4000-8000-000000000001',
        scope: 'baseline',
        planDigest: 'plan-digest',
        result: {
          checkId: 'test',
          passed: true,
          detail: 'All tests pass',
          executedAt: FIXED_TIME,
          kind: 'test',
          command: 'npm test',
          exitCode: 0,
          executionMs: 1500,
          outputDigest: VALID_DIGEST,
          timedOut: false,
          outcome: 'supported' as const,
        },
      });
      expect(result.scope).toBe('baseline');
      if (result.scope !== 'baseline') throw new Error('Expected baseline validation attempt');
      expect(result.planDigest).toBe('plan-digest');
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

    it('rejects an implementation scope with a baseline digest binding', () => {
      expect(() =>
        ValidationAttempt.parse({
          attemptId: '00000000-0000-4000-8000-000000000001',
          scope: 'implementation',
          planDigest: 'plan-digest',
          result: {
            checkId: 'test',
            passed: true,
            detail: 'All tests pass',
            executedAt: FIXED_TIME,
            kind: 'test',
            command: 'npm test',
            exitCode: 0,
            executionMs: 1500,
            outputDigest: VALID_DIGEST,
            timedOut: false,
            outcome: 'supported' as const,
          },
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

  describe('isExecutionError (F5)', () => {
    it('true when timedOut', () => {
      expect(isExecutionError({ timedOut: true, exitCode: 124 })).toBe(true);
    });
    it('true for exit 124 even if timedOut flag is false', () => {
      expect(isExecutionError({ timedOut: false, exitCode: 124 })).toBe(true);
    });
    it('true for exit 127 (command not found)', () => {
      expect(isExecutionError({ timedOut: false, exitCode: 127 })).toBe(true);
    });
    it('false for a passing check (exit 0)', () => {
      expect(isExecutionError({ timedOut: false, exitCode: 0 })).toBe(false);
    });
    it('false for an ordinary failure (exit 1)', () => {
      expect(isExecutionError({ timedOut: false, exitCode: 1 })).toBe(false);
    });
  });
});
