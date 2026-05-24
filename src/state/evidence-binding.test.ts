/**
 * @module evidence-binding.test
 * @description Tests for evidence-binding module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { BindingInfo } from './evidence-binding.js';
import { FIXED_TIME } from './evidence-test-constants.js';

describe('evidence-binding', () => {
  describe('HAPPY', () => {
    it('BindingInfo parses valid binding with OpenCode-style session ID', () => {
      const binding = {
        sessionId: 'ses_260740c65ffe77OjxRP7z40yH8',
        worktree: '/tmp/test-repo',
        fingerprint: 'abcdef0123456789abcdef01',
        resolvedAt: FIXED_TIME,
      };
      expect(BindingInfo.parse(binding)).toEqual(binding);
    });
  });

  describe('BAD', () => {
    it('BindingInfo rejects unsafe session IDs', () => {
      expect(() =>
        BindingInfo.parse({
          sessionId: '../etc/passwd',
          worktree: '/tmp/test',
          fingerprint: 'abcdef0123456789abcdef01',
          resolvedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('BindingInfo rejects empty worktree', () => {
      expect(() =>
        BindingInfo.parse({
          sessionId: 'ses_test',
          worktree: '',
          fingerprint: 'abcdef0123456789abcdef01',
          resolvedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('BindingInfo rejects invalid fingerprint (wrong length)', () => {
      expect(() =>
        BindingInfo.parse({
          sessionId: 'ses_test',
          worktree: '/tmp/test',
          fingerprint: 'abc',
          resolvedAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('BindingInfo rejects missing fingerprint', () => {
      expect(() =>
        BindingInfo.parse({
          sessionId: 'ses_test',
          worktree: '/tmp/test',
          resolvedAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });

  describe('EDGE', () => {
    it('BindingInfo fingerprint must be 24-hex', () => {
      // Valid 24-hex
      expect(() =>
        BindingInfo.parse({
          sessionId: 'ses_test',
          worktree: '/tmp/test',
          fingerprint: 'abcdef0123456789abcdef01',
          resolvedAt: FIXED_TIME,
        }),
      ).not.toThrow();
      // Invalid: 23 chars
      expect(() =>
        BindingInfo.parse({
          sessionId: 'ses_test',
          worktree: '/tmp/test',
          fingerprint: 'abc',
          resolvedAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });
});
