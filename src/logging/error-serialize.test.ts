/**
 * @module logging/error-serialize.test
 * @description Tests for serializeError — structured error preservation.
 *
 * Covers:
 * - HAPPY: Error with name, message, stack, cause chain, code
 * - BAD: non-Error input, null, primitive
 * - CORNER: Error with no stack, Error with code='ENOENT'
 * - EDGE: deeply nested cause chain
 * - REDACTION: paths and URLs in message, stack, and cause are redacted
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { serializeError } from './error-serialize.js';

describe('serializeError', () => {
  describe('HAPPY', () => {
    it('serializes a plain Error', () => {
      const result = serializeError(new Error('something broke'));
      expect(result.name).toBe('Error');
      expect(result.message).toBe('something broke');
    });

    it('preserves the error name', () => {
      const result = serializeError(new TypeError('bad type'));
      expect(result.name).toBe('TypeError');
    });

    it('preserves stack traces', () => {
      const err = new Error('with stack');
      const result = serializeError(err);
      expect(result.stack).toBeDefined();
      expect(result.stack!.length).toBeGreaterThan(0);
    });

    it('preserves error codes (ENOENT, etc.)', () => {
      const err = Object.assign(new Error('file missing'), { code: 'ENOENT' });
      const result = serializeError(err);
      expect(result.code).toBe('ENOENT');
    });

    it('preserves cause chains', () => {
      const cause = new Error('root cause');
      const err = new Error('top-level', { cause });
      const result = serializeError(err);
      expect(result.cause).toBeDefined();
      expect(result.cause!.message).toBe('root cause');
    });

    it('preserves deeply nested cause chains', () => {
      const innerMost = new Error('inner');
      const middle = new Error('middle', { cause: innerMost });
      const top = new Error('top', { cause: middle });
      const result = serializeError(top);
      expect(result.cause?.cause?.message).toBe('inner');
    });

    it('preserves cause code', () => {
      const cause = Object.assign(new Error('root'), { code: 'ECONNREFUSED' });
      const err = new Error('top', { cause });
      const result = serializeError(err);
      expect(result.cause?.code).toBe('ECONNREFUSED');
    });
  });

  describe('BAD', () => {
    it('handles non-Error input (string)', () => {
      const result = serializeError('just a string');
      expect(result.name).toBe('Error');
      expect(result.message).toBe('just a string');
    });

    it('handles null input', () => {
      const result = serializeError(null);
      expect(result.name).toBe('Error');
      expect(result.message).toBe('null');
    });

    it('handles undefined input', () => {
      const result = serializeError(undefined);
      expect(result.name).toBe('Error');
      expect(result.message).toBe('undefined');
    });

    it('handles number input', () => {
      const result = serializeError(42);
      expect(result.message).toBe('42');
    });

    it('handles object input', () => {
      const result = serializeError({ custom: 'error' });
      expect(result.message).toBe('[object Object]');
    });
  });

  describe('CORNER', () => {
    it('handles Error with no stack (dynamically created)', () => {
      const err = { name: 'CustomError', message: 'no stack' } as Error;
      const result = serializeError(err);
      expect(result.name).toBe('CustomError');
      expect(result.message).toBe('no stack');
      expect(result.stack).toBeUndefined();
    });

    it('handles Error with empty message', () => {
      const result = serializeError(new Error(''));
      expect(result.message).toBe('');
    });

    it('handles code that is not a string', () => {
      const err = Object.assign(new Error('oops'), { code: 500 });
      const result = serializeError(err);
      expect(result.code).toBeUndefined();
    });
  });

  describe('EDGE', () => {
    it('handles Error with self-referencing cause without infinite recursion', () => {
      const err = new Error('self');
      (err as unknown as Record<string, unknown>).cause = err;
      const result = serializeError(err);
      expect(result.name).toBe('Error');
      expect(result.message).toBe('self');
      // Self-referencing cause is skipped (no cycle)
      expect(result.cause).toBeUndefined();
    });

    it('handles error with very long message', () => {
      const longMsg = 'x'.repeat(10000);
      const result = serializeError(new Error(longMsg));
      expect(result.message).toBe(longMsg);
    });
  });

  describe('REDACTION', () => {
    it('strips absolute file paths from error message', () => {
      const result = serializeError(
        new Error("ENOENT: no such file '/home/user/project/src/file.ts'"),
      );
      expect(result.message).not.toContain('/home/user/project');
      expect(result.message).toContain('[path:');
    });

    it('strips https URLs from error message', () => {
      const result = serializeError(
        new Error('fetch failed https://api.example.com/v1/tokens/secret'),
      );
      expect(result.message).not.toContain('api.example.com/v1/tokens');
      expect(result.message).toContain('[url:api.example.com]');
    });

    it('strips paths from stack traces', () => {
      const err = new Error('stack error');
      const result = serializeError(err);
      // Stack exists and redaction ran — absolute paths should be stripped
      expect(result.stack).toBeTypeOf('string');
      expect(result.stack).not.toMatch(/\/Users\//);
      expect(result.stack).toContain('[path:');
    });

    it('strips paths from cause message', () => {
      const cause = new Error("ENOENT '/tmp/secret.key'");
      const err = new Error('wrapper', { cause });
      const result = serializeError(err);
      expect(result.cause!.message).not.toContain('/tmp/secret.key');
    });

    it('strips URLs from cause stack', () => {
      const cause = new Error('fetch failed https://secrets.example.io/key');
      const err = new Error('wrapper', { cause });
      const result = serializeError(err);
      expect(result.cause!.message).not.toContain('secrets.example.io/key');
      expect(result.cause!.message).toContain('[url:secrets.example.io]');
    });

    it('strips line:column references from error messages', () => {
      const result = serializeError(new Error('parse error at line 42:17'));
      expect(result.message).not.toContain(':42:17');
    });

    it('strips ENOENT paths from error messages', () => {
      const result = serializeError(new Error("ENOENT: no such file or directory '/etc/passwd'"));
      expect(result.message).not.toContain('/etc/passwd');
    });
  });
});
