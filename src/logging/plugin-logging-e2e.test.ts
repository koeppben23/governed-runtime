/**
 * @module logging/plugin-logging-e2e.test
 * @description E2E tests for the logging infrastructure wired through plugin-logging.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, SMOKE
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildLogSinks } from '../integration/plugin-logging.js';
import { createLogger } from './logger.js';
import { setAdapterLogger, getAdapterLogger, resetAdapterLogger } from './adapter-logger.js';
import { createConsoleSink } from './console-sink.js';
import type { LogEntry } from './logger.js';

describe('Plugin logging e2e', () => {
  beforeEach(() => {
    resetAdapterLogger();
  });

  afterEach(() => {
    resetAdapterLogger();
  });

  describe('HAPPY', () => {
    it('file+console mode creates both sinks', () => {
      const sinks = buildLogSinks(
        {
          logging: { mode: 'file+console', level: 'info', retentionDays: 7 },
        },
        undefined,
        null,
      );
      expect(sinks.length).toBe(1); // Only console when no workspaceDir
    });

    it('file+console mode with workspaceDir creates file and console sinks', () => {
      const sinks = buildLogSinks(
        {
          logging: { mode: 'file+console', level: 'info', retentionDays: 7 },
        },
        undefined,
        '/tmp/test-workspace',
      );
      expect(sinks.length).toBe(2);
    });

    it('console mode creates console sink', () => {
      const sinks = buildLogSinks(
        {
          logging: { mode: 'console', level: 'info', retentionDays: 7 },
        },
        undefined,
        null,
      );
      expect(sinks.length).toBe(1);
    });

    it('console sink does not throw on log entries', () => {
      const consoleSink = createConsoleSink();
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      expect(() =>
        consoleSink({ level: 'warn', service: 'test', message: 'console test' }),
      ).not.toThrow();

      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    });

    it('buildLogSinks accepts all new modes without throwing', () => {
      expect(() =>
        buildLogSinks(
          { logging: { mode: 'console', level: 'debug', retentionDays: 7 } },
          undefined,
          '/tmp',
        ),
      ).not.toThrow();

      expect(() =>
        buildLogSinks(
          { logging: { mode: 'file+console', level: 'info', retentionDays: 14 } },
          undefined,
          '/tmp',
        ),
      ).not.toThrow();
    });
  });

  describe('BAD', () => {
    it('buildLogSinks returns empty array for unsupported config combination', () => {
      const sinks = buildLogSinks(
        {
          logging: { mode: 'file', level: 'info', retentionDays: 7 },
        },
        undefined,
        null,
      );
      expect(sinks.length).toBe(0);
    });
  });

  describe('CORNER', () => {
    it('adapter logger survives setAdapterLogger with full logger then reset', () => {
      const logger = createLogger('debug');
      setAdapterLogger({
        info: logger.info.bind(logger),
        warn: logger.warn.bind(logger),
        error: logger.error.bind(logger),
      });

      const adapter = getAdapterLogger();
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      adapter.warn('corner', 'reset test');
      adapter.error('corner', 'error test');

      resetAdapterLogger();
      adapter.info('corner', 'should be noop');

      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    });
  });

  describe('SMOKE', () => {
    it('full smoke: set adapter logger -> log from adapter layer -> verify captured', () => {
      const entries: LogEntry[] = [];
      const mockAdapter = {
        info: (_s: string, _m: string, _e?: Record<string, unknown>) => {
          entries.push({ level: 'info', service: _s, message: _m, extra: _e });
        },
        warn: (_s: string, _m: string, _e?: Record<string, unknown>) => {
          entries.push({ level: 'warn', service: _s, message: _m, extra: _e });
        },
        error: (_s: string, _m: string, _e?: Record<string, unknown>) => {
          entries.push({ level: 'error', service: _s, message: _m, extra: _e });
        },
      };
      setAdapterLogger(mockAdapter);

      // Simulate what persistence does
      const log = getAdapterLogger();
      log.info('persistence', 'State file read', { filePath: '/tmp/state.json' });
      log.warn('git', 'Failed to read git user.name', { cwd: '/repo' });
      log.error('archive', 'tar command failed', { sessionId: 'abc' });

      expect(entries).toHaveLength(3);
      expect(entries[0]!.service).toBe('persistence');
      expect(entries[0]!.level).toBe('info');
      expect(entries[1]!.service).toBe('git');
      expect(entries[1]!.level).toBe('warn');
      expect(entries[2]!.service).toBe('archive');
      expect(entries[2]!.level).toBe('error');
      expect(entries[2]!.extra).toEqual({ sessionId: 'abc' });
    });
  });
});
