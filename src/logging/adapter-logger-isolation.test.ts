/**
 * @module logging/adapter-logger-isolation.test
 * @description Multi-session isolation tests for the ALS-scoped adapter logger.
 *
 * Validates that:
 * - Different scopes carry different loggers
 * - Loggers do not leak between scopes
 * - Reset behavior works correctly
 *
 * @test-policy HAPPY, CORNER, EDGE
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setAdapterLogger,
  getAdapterLogger,
  resetAdapterLogger,
  runWithAdapterLogger,
  type AdapterLogger,
} from './adapter-logger.js';

describe('AdapterLogger scope isolation', () => {
  beforeEach(() => {
    resetAdapterLogger();
  });

  afterEach(() => {
    resetAdapterLogger();
  });

  describe('HAPPY', () => {
    it('two sequential scopes do not leak', () => {
      const firstCalls: string[] = [];
      const secondCalls: string[] = [];

      runWithAdapterLogger(
        {
          info: (_s, m) => firstCalls.push(m),
          warn: (_s, m) => firstCalls.push(m),
          error: (_s, m) => firstCalls.push(m),
        },
        () => {
          getAdapterLogger().warn('s1', 'first-log');
        },
      );

      runWithAdapterLogger(
        {
          info: (_s, m) => secondCalls.push(m),
          warn: (_s, m) => secondCalls.push(m),
          error: (_s, m) => secondCalls.push(m),
        },
        () => {
          getAdapterLogger().warn('s2', 'second-log');
        },
      );

      expect(firstCalls).toEqual(['first-log']);
      expect(secondCalls).toEqual(['second-log']);
    });

    it('reset clears the top-level logger', () => {
      const calls: string[] = [];
      setAdapterLogger({
        info: (_s, m) => calls.push(m),
        warn: (_s, m) => calls.push(m),
        error: (_s, m) => calls.push(m),
      });
      getAdapterLogger().warn('x', 'before');
      expect(calls).toEqual(['before']);

      resetAdapterLogger();
      getAdapterLogger().warn('x', 'after-reset');
      expect(calls).toEqual(['before']); // unchanged — noop after reset
    });
  });
});
