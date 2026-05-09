/**
 * @module logging/adapter-logger.test
 * @description Tests for the ALS-scoped adapter logger.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, SMOKE
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setAdapterLogger,
  getAdapterLogger,
  resetAdapterLogger,
  runWithAdapterLogger,
  runWithAdapterLoggerAsync,
  toAdapterLogger,
  type AdapterLogger,
} from './adapter-logger.js';
import { createLogger, type FlowGuardLogger } from './logger.js';

describe('AdapterLogger — ALS-scoped DI', () => {
  beforeEach(() => {
    resetAdapterLogger();
  });

  describe('HAPPY', () => {
    it('getAdapterLogger returns noop when no scope set', () => {
      const log = getAdapterLogger();
      expect(() => log.info('test', 'msg')).not.toThrow();
      expect(() => log.warn('test', 'msg')).not.toThrow();
      expect(() => log.error('test', 'msg')).not.toThrow();
    });

    it('runWithAdapterLogger injects scoped logger', () => {
      const mock: AdapterLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      runWithAdapterLogger(mock, () => {
        getAdapterLogger().warn('svc', 'test');
        getAdapterLogger().error('svc', 'err');
      });
      expect(mock.warn).toHaveBeenCalledWith('svc', 'test');
      expect(mock.error).toHaveBeenCalledWith('svc', 'err');
    });

    it('logger reverts to noop after scope exits', () => {
      const mock: AdapterLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      runWithAdapterLogger(mock, () => {
        getAdapterLogger().warn('s', 'scoped');
      });
      getAdapterLogger().warn('s', 'unscoped');
      expect(mock.warn).toHaveBeenCalledTimes(1);
      expect(mock.warn).toHaveBeenCalledWith('s', 'scoped');
    });

    it('nested runWithAdapterLogger uses inner logger', () => {
      const outer: AdapterLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const inner: AdapterLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      runWithAdapterLogger(outer, () => {
        getAdapterLogger().warn('s', 'outer');
        runWithAdapterLogger(inner, () => {
          getAdapterLogger().error('s', 'inner');
        });
        getAdapterLogger().warn('s', 'outer2');
      });

      expect(outer.warn).toHaveBeenCalledTimes(2);
      expect(inner.error).toHaveBeenCalledTimes(1);
      expect(outer.error).not.toHaveBeenCalled();
      expect(inner.warn).not.toHaveBeenCalled();
    });

    it('runWithAdapterLoggerAsync works for async scopes', async () => {
      const mock: AdapterLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      await runWithAdapterLoggerAsync(mock, async () => {
        await Promise.resolve();
        getAdapterLogger().error('s', 'async err');
        await Promise.resolve();
        getAdapterLogger().warn('s', 'async warn');
      });
      expect(mock.error).toHaveBeenCalledWith('s', 'async err');
      expect(mock.warn).toHaveBeenCalledWith('s', 'async warn');
    });
  });

  describe('CORNER', () => {
    it('two parallel scopes do not interfere', async () => {
      const aCalls: string[] = [];
      const bCalls: string[] = [];
      const aLog: AdapterLogger = {
        info: (_s, m) => aCalls.push(m),
        warn: (_s, m) => aCalls.push(m),
        error: (_s, m) => aCalls.push(m),
      };
      const bLog: AdapterLogger = {
        info: (_s, m) => bCalls.push(m),
        warn: (_s, m) => bCalls.push(m),
        error: (_s, m) => bCalls.push(m),
      };

      await Promise.all([
        runWithAdapterLoggerAsync(aLog, async () => {
          getAdapterLogger().error('x', 'a1');
          await Promise.resolve();
          getAdapterLogger().warn('x', 'a2');
        }),
        runWithAdapterLoggerAsync(bLog, async () => {
          getAdapterLogger().error('x', 'b1');
          await Promise.resolve();
          getAdapterLogger().warn('x', 'b2');
        }),
      ]);

      expect(aCalls).toEqual(['a1', 'a2']);
      expect(bCalls).toEqual(['b1', 'b2']);
    });
  });

  describe('EDGE', () => {
    it('runWithAdapterLogger returns the function return value', () => {
      const result = runWithAdapterLogger(
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        () => 42,
      );
      expect(result).toBe(42);
    });

    it('toAdapterLogger wraps FlowGuardLogger', () => {
      const calls: string[] = [];
      const logger: FlowGuardLogger = createLogger('debug');
      // Spy on the info/warn/error methods
      vi.spyOn(logger, 'info').mockImplementation((_s, m) => calls.push(`i:${m}`));
      vi.spyOn(logger, 'warn').mockImplementation((_s, m) => calls.push(`w:${m}`));
      vi.spyOn(logger, 'error').mockImplementation((_s, m) => calls.push(`e:${m}`));

      const adapter = toAdapterLogger(logger);
      adapter.info('x', 'hi');
      adapter.warn('x', 'w');
      adapter.error('x', 'e');
      expect(calls).toEqual(['i:hi', 'w:w', 'e:e']);
    });
  });

  describe('SMOKE', () => {
    it('full lifecycle: set -> run scoped -> revert', () => {
      const calls: string[] = [];
      const log: AdapterLogger = {
        info: (_s, m) => calls.push(`i:${m}`),
        warn: (_s, m) => calls.push(`w:${m}`),
        error: (_s, m) => calls.push(`e:${m}`),
      };

      setAdapterLogger(log);
      getAdapterLogger().warn('a', 'default');

      runWithAdapterLogger(
        { info: vi.fn(), warn: (_, m) => calls.push(`scoped:${m}`), error: vi.fn() },
        () => {
          getAdapterLogger().warn('a', 'scoped-only');
        },
      );

      getAdapterLogger().warn('a', 'back-to-default');

      expect(calls).toEqual(['w:default', 'scoped:scoped-only', 'w:back-to-default']);
    });
  });
});
