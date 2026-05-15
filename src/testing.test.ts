/**
 * @module testing.test
 * @description Functional tests for the testing module.
 *
 * Tests the createTestContext helper's contract, not the package subpath export.
 * Subpath resolution is verified in the install-verify smoke tests.
 *
 * @test-policy HAPPY
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { createTestContext } from './testing.js';

describe('testing module', () => {
  it('returns default time and digest function', () => {
    const ctx = createTestContext();
    expect(ctx.now()).toBe('2026-01-01T00:00:00.000Z');
    expect(ctx.digest('hello')).toBe('digest-of-hello');
  });

  it('accepts custom fixed time', () => {
    const ctx = createTestContext('custom-time');
    expect(ctx.now()).toBe('custom-time');
  });

  it('accepts custom digest function', () => {
    const digest = (text: string) => `hash:${text}`;
    const ctx = createTestContext(undefined, digest);
    expect(ctx.digest('world')).toBe('hash:world');
  });

  it('returns a fresh context each call', () => {
    const a = createTestContext();
    const b = createTestContext();
    expect(a).not.toBe(b);
  });
});
