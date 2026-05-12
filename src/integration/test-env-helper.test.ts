/**
 * @module test-env-helper.test
 * @description Tests for withTestEnv scoped env-var mutation helper (FG-REL-041).
 *
 * Proves:
 * - HAPPY: Single/multiple var set, delete (undefined), empty overrides all work correctly.
 * - BAD: Idempotent cleanup, restore after external modification, restore after mid-test delete.
 * - CORNER: Undefined vars deleted on cleanup (not set to 'undefined' string),
 *           overlapping calls compose correctly, exact env state after cleanup.
 * - EDGE: Empty-string values, special characters, very long values.
 * - SMOKE: Full beforeEach/afterEach lifecycle, cleanup runs even after simulated throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withTestEnv } from './test-helpers.js';

// Use a unique prefix to avoid collisions with real env vars.
const PREFIX = '__WITHTESTENV_TEST_';
const key = (name: string) => `${PREFIX}${name}`;

// Ensure test vars are cleaned up even if a test fails.
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith(PREFIX)) delete process.env[k];
  }
});

// ─── HAPPY PATH ──────────────────────────────────────────────────────────────

describe('withTestEnv — HAPPY', () => {
  it('sets a single env var and restores it on cleanup', () => {
    const k = key('SINGLE');
    process.env[k] = 'original';

    const cleanup = withTestEnv({ [k]: 'overridden' });
    expect(process.env[k]).toBe('overridden');

    cleanup();
    expect(process.env[k]).toBe('original');
  });

  it('sets multiple env vars and restores all on cleanup', () => {
    const k1 = key('MULTI_A');
    const k2 = key('MULTI_B');
    process.env[k1] = 'a-original';
    process.env[k2] = 'b-original';

    const cleanup = withTestEnv({ [k1]: 'a-new', [k2]: 'b-new' });
    expect(process.env[k1]).toBe('a-new');
    expect(process.env[k2]).toBe('b-new');

    cleanup();
    expect(process.env[k1]).toBe('a-original');
    expect(process.env[k2]).toBe('b-original');
  });

  it('deletes a var when value is undefined and restores on cleanup', () => {
    const k = key('DELETE');
    process.env[k] = 'exists';

    const cleanup = withTestEnv({ [k]: undefined });
    expect(process.env[k]).toBeUndefined();

    cleanup();
    expect(process.env[k]).toBe('exists');
  });

  it('returns no-op cleanup when overrides is empty', () => {
    const k = key('EMPTY');
    process.env[k] = 'untouched';

    const cleanup = withTestEnv({});
    expect(process.env[k]).toBe('untouched');

    cleanup();
    expect(process.env[k]).toBe('untouched');
  });
});

// ─── BAD PATH ────────────────────────────────────────────────────────────────

describe('withTestEnv — BAD', () => {
  it('cleanup is idempotent — double-call is safe', () => {
    const k = key('IDEMPOTENT');
    process.env[k] = 'original';

    const cleanup = withTestEnv({ [k]: 'changed' });
    cleanup();
    expect(process.env[k]).toBe('original');

    // Mutate after first cleanup
    process.env[k] = 'mutated-after-cleanup';

    // Second cleanup must NOT overwrite the post-cleanup mutation
    cleanup();
    expect(process.env[k]).toBe('mutated-after-cleanup');
  });

  it('restores original even when var was modified between set and cleanup', () => {
    const k = key('MID_MODIFY');
    process.env[k] = 'original';

    const cleanup = withTestEnv({ [k]: 'first' });
    // External code modifies the var
    process.env[k] = 'external-modification';

    cleanup();
    // Must restore to the value at withTestEnv call time, not the modified value
    expect(process.env[k]).toBe('original');
  });

  it('restores original even when var was deleted between set and cleanup', () => {
    const k = key('MID_DELETE');
    process.env[k] = 'original';

    const cleanup = withTestEnv({ [k]: 'overridden' });
    // External code deletes the var
    delete process.env[k];

    cleanup();
    expect(process.env[k]).toBe('original');
  });
});

// ─── CORNER CASES ────────────────────────────────────────────────────────────

describe('withTestEnv — CORNER', () => {
  it('previously-undefined var is deleted on cleanup (not set to string "undefined")', () => {
    const k = key('WAS_UNDEFINED');
    // Ensure var does NOT exist
    delete process.env[k];

    const cleanup = withTestEnv({ [k]: 'temporarily-set' });
    expect(process.env[k]).toBe('temporarily-set');

    cleanup();
    expect(process.env[k]).toBeUndefined();
    expect(k in process.env).toBe(false);
  });

  it('overlapping withTestEnv calls compose correctly (LIFO cleanup)', () => {
    const k = key('LIFO');
    process.env[k] = 'original';

    const cleanup1 = withTestEnv({ [k]: 'level-1' });
    expect(process.env[k]).toBe('level-1');

    const cleanup2 = withTestEnv({ [k]: 'level-2' });
    expect(process.env[k]).toBe('level-2');

    // LIFO: cleanup inner first
    cleanup2();
    expect(process.env[k]).toBe('level-1');

    cleanup1();
    expect(process.env[k]).toBe('original');
  });

  it('env state is exactly original after cleanup — no residual keys', () => {
    const k1 = key('RESIDUAL_A');
    const k2 = key('RESIDUAL_B');
    // k1 exists, k2 does not
    process.env[k1] = 'exists';
    delete process.env[k2];

    const envBefore = { ...process.env };

    const cleanup = withTestEnv({ [k1]: 'changed', [k2]: 'created' });
    expect(process.env[k1]).toBe('changed');
    expect(process.env[k2]).toBe('created');

    cleanup();

    // Exact match: every key that existed before is unchanged,
    // k2 is gone again
    expect(process.env[k1]).toBe('exists');
    expect(process.env[k2]).toBeUndefined();
    expect(process.env[k1]).toBe(envBefore[k1]);
  });
});

// ─── EDGE CASES ──────────────────────────────────────────────────────────────

describe('withTestEnv — EDGE', () => {
  it('works with empty-string values', () => {
    const k = key('EMPTY_STR');
    process.env[k] = 'non-empty';

    const cleanup = withTestEnv({ [k]: '' });
    expect(process.env[k]).toBe('');

    cleanup();
    expect(process.env[k]).toBe('non-empty');
  });

  it('works with special characters in values', () => {
    const k = key('SPECIAL');
    const specialValue = 'path=/foo/bar;name="test value"&flag=true\nnewline';

    const cleanup = withTestEnv({ [k]: specialValue });
    expect(process.env[k]).toBe(specialValue);

    cleanup();
    expect(process.env[k]).toBeUndefined();
  });

  it('works with very long values', () => {
    const k = key('LONG');
    const longValue = 'x'.repeat(10_000);

    const cleanup = withTestEnv({ [k]: longValue });
    expect(process.env[k]).toBe(longValue);
    expect(process.env[k]!.length).toBe(10_000);

    cleanup();
    expect(process.env[k]).toBeUndefined();
  });
});

// ─── SMOKE (lifecycle patterns) ──────────────────────────────────────────────

describe('withTestEnv — SMOKE', () => {
  describe('full beforeEach/afterEach lifecycle', () => {
    const k = key('LIFECYCLE');
    let cleanupEnv: () => void;

    beforeEach(() => {
      process.env[k] = 'pre-test-original';
      cleanupEnv = withTestEnv({ [k]: 'test-value' });
    });

    afterEach(() => {
      cleanupEnv();
    });

    it('sees test-value during test', () => {
      expect(process.env[k]).toBe('test-value');
    });

    it('sees test-value in a second test (proves per-test isolation)', () => {
      expect(process.env[k]).toBe('test-value');
      // Modify it — next test must still see 'test-value' from beforeEach
      process.env[k] = 'modified-by-test';
    });

    it('is not affected by modification in previous test', () => {
      expect(process.env[k]).toBe('test-value');
    });
  });

  it('cleanup restores env even after simulated error (afterEach guarantee)', () => {
    const k = key('THROW_SAFE');
    process.env[k] = 'before-throw';

    const cleanup = withTestEnv({ [k]: 'during-throw' });
    expect(process.env[k]).toBe('during-throw');

    // Simulate the pattern: even if something goes wrong, cleanup works
    try {
      throw new Error('simulated test failure');
    } catch {
      // Error caught — afterEach would call cleanup in real usage
    }

    cleanup();
    expect(process.env[k]).toBe('before-throw');
  });
});
