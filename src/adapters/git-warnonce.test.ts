/**
 * @module adapters/git-warnonce.test
 * @description Git callsite test proving warnOnce deduplicates fallback warnings.
 *
 * @test-policy HAPPY, CORNER
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { currentBranch } from './git.js';
import { runWithAdapterLogger, type AdapterLogger } from '../logging/adapter-logger.js';

// Make git() fail so currentBranch triggers the fallback catch + logWarn
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    (cb as (err: Error) => void)(new Error('git not available for test'));
  }),
  execFileSync: vi.fn(() => {
    throw new Error('git not available for test');
  }),
}));

describe('git.ts warnOnce callsite proof', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('HAPPY', () => {
    it('currentBranch fallback is deduplicated via warnOnce — 3 calls, 1 warn', async () => {
      const mockWarn = vi.fn();
      const logger: AdapterLogger = { info: vi.fn(), warn: mockWarn, error: vi.fn() };

      await runWithAdapterLogger(logger, async () => {
        // Real git.ts currentBranch — will fail because execFile above throws
        await currentBranch('/nonexistent');
        await currentBranch('/nonexistent');
        await currentBranch('/nonexistent');
      });

      // Only the adapter's `.warn` method was called by warnOnce dedup
      expect(mockWarn).toHaveBeenCalledTimes(1);
    });

    it('different git fallbacks produce separate warnings', async () => {
      const mockWarn = vi.fn();
      const logger: AdapterLogger = { info: vi.fn(), warn: mockWarn, error: vi.fn() };

      // Import headCommit as well for a different fallback
      const { headCommit } = await import('./git.js');

      await runWithAdapterLogger(logger, async () => {
        await currentBranch('/nonexistent');
        await currentBranch('/nonexistent');
        await headCommit('/nonexistent');
        await headCommit('/nonexistent');
      });

      // Two distinct messages → 2 warns
      expect(mockWarn).toHaveBeenCalledTimes(2);
    });
  });

  describe('CORNER', () => {
    it('new ALS scope resets warnOnce cache', async () => {
      const mockWarn = vi.fn();
      const logger: AdapterLogger = { info: vi.fn(), warn: mockWarn, error: vi.fn() };

      await runWithAdapterLogger(logger, async () => {
        await currentBranch('/nonexistent');
        await currentBranch('/nonexistent');
      });

      // New scope — cache reset, same message should warn again
      const mockWarn2 = vi.fn();
      const logger2: AdapterLogger = { info: vi.fn(), warn: mockWarn2, error: vi.fn() };

      await runWithAdapterLogger(logger2, async () => {
        await currentBranch('/nonexistent');
      });

      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn2).toHaveBeenCalledTimes(1);
    });
  });
});
