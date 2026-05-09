/**
 * @module logging/console-sink.test
 * @description Tests for the console logging sink.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createConsoleSink } from './console-sink.js';
import type { LogEntry } from './logger.js';

describe('createConsoleSink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  describe('HAPPY', () => {
    it('logs error entries to stderr', () => {
      const sink = createConsoleSink();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      sink({ level: 'error', service: 'test', message: 'something failed' });

      expect(stderr).toHaveBeenCalledOnce();
      const call = stderr.mock.calls[0]![0] as string;
      expect(call).toContain('[ERROR]');
      expect(call).toContain('test');
      expect(call).toContain('something failed');
      expect(stdout).not.toHaveBeenCalled();
    });

    it('logs warn entries to stderr', () => {
      const sink = createConsoleSink();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      sink({ level: 'warn', service: 'audit', message: 'degraded' });

      expect(stderr).toHaveBeenCalledOnce();
      expect(stdout).not.toHaveBeenCalled();
    });

    it('logs info entries to stderr (not stdout)', () => {
      const sink = createConsoleSink();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      sink({ level: 'info', service: 'plugin', message: 'initialized' });

      expect(stderr).toHaveBeenCalledOnce();
      const call = stderr.mock.calls[0]![0] as string;
      expect(call).toContain('[INFO]');
      expect(call).toContain('plugin');
      expect(call).toContain('initialized');
      expect(stdout).not.toHaveBeenCalled();
    });

    it('logs debug entries to stderr', () => {
      const sink = createConsoleSink();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      sink({ level: 'debug', service: 'audit', message: 'trace' });

      expect(stderr).toHaveBeenCalledOnce();
      expect(stdout).not.toHaveBeenCalled();
    });

    it('includes extra fields in output', () => {
      const sink = createConsoleSink();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      sink({ level: 'info', service: 'test', message: 'ok', extra: { sessionId: 's1' } });

      const call = stderr.mock.calls[0]![0] as string;
      expect(call).toContain('"sessionId":"s1"');
    });

    it('includes timestamp in output', () => {
      const sink = createConsoleSink();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      sink({ level: 'info', service: 'test', message: 'ts test' });

      const call = stderr.mock.calls[0]![0] as string;
      expect(call).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('BAD', () => {
    it('swallows stderr write errors without throwing', () => {
      const sink = createConsoleSink();
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
        throw new Error('stderr broken');
      });
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      expect(() => sink({ level: 'error', service: 'test', message: 'error' })).not.toThrow();
    });
  });

  describe('CORNER', () => {
    it('handles entries with extra set to undefined', () => {
      const sink = createConsoleSink();
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      const entry: LogEntry = { level: 'info', service: 'test', message: 'no extra' };
      expect(() => sink(entry)).not.toThrow();
    });

    it('JSON.stringify errors in extra do not crash the sink', () => {
      const sink = createConsoleSink();
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      const circular: Record<string, unknown> = {};
      (circular as Record<string, unknown>).self = circular;

      expect(() =>
        sink({ level: 'info', service: 'test', message: 'circular', extra: circular }),
      ).not.toThrow();
    });
  });

  describe('EDGE', () => {
    it('is a valid LogSink (returns void synchronously)', () => {
      const sink = createConsoleSink();
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const result = sink({ level: 'info', service: 'test', message: 'edge' });
      expect(result).toBeUndefined();
    });
  });
});
