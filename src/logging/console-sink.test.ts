/**
 * @module logging/console-sink.test
 * @description Tests for the console logging sink.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConsoleSink } from './console-sink.js';
import type { LogEntry } from './logger.js';

function collectStderr(): { output: string; restore: () => void } {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    get output() {
      return chunks.join('');
    },
    restore: () => {
      write.mockRestore();
      stdoutWrite.mockRestore();
    },
  };
}

describe('createConsoleSink', () => {
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

      stderr.mockRestore();
      stdout.mockRestore();
    });

    it('logs warn entries to stderr', () => {
      const sink = createConsoleSink();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      sink({ level: 'warn', service: 'audit', message: 'degraded' });

      expect(stderr).toHaveBeenCalledOnce();
      const call = stderr.mock.calls[0]![0] as string;
      expect(call).toContain('[WARN]');
      expect(call).toContain('audit');
      expect(call).toContain('degraded');

      stderr.mockRestore();
      stdout.mockRestore();
    });

    it('logs info entries to stdout', () => {
      const sink = createConsoleSink();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      sink({ level: 'info', service: 'plugin', message: 'initialized' });

      expect(stdout).toHaveBeenCalledOnce();
      const call = stdout.mock.calls[0]![0] as string;
      expect(call).toContain('[INFO]');
      expect(call).toContain('plugin');
      expect(call).toContain('initialized');

      stderr.mockRestore();
      stdout.mockRestore();
    });

    it('includes extra fields in output', () => {
      const sink = createConsoleSink();
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      sink({ level: 'info', service: 'test', message: 'ok', extra: { sessionId: 's1' } });

      const call = stdout.mock.calls[0]![0] as string;
      expect(call).toContain('"sessionId":"s1"');

      stdout.mockRestore();
      stderr.mockRestore();
    });

    it('includes timestamp in output', () => {
      const sink = createConsoleSink();
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      sink({ level: 'info', service: 'test', message: 'ts test' });

      const call = stdout.mock.calls[0]![0] as string;
      expect(call).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      stdout.mockRestore();
      stderr.mockRestore();
    });
  });

  describe('BAD', () => {
    it('swallows stderr write errors without throwing', () => {
      const sink = createConsoleSink();
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
        throw new Error('stderr broken');
      });
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      expect(() => sink({ level: 'error', service: 'test', message: 'error' })).not.toThrow();

      stderr.mockRestore();
      stdout.mockRestore();
    });

    it('swallows stdout write errors without throwing', () => {
      const sink = createConsoleSink();
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
        throw new Error('stdout broken');
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      expect(() => sink({ level: 'info', service: 'test', message: 'info' })).not.toThrow();

      stdout.mockRestore();
      stderr.mockRestore();
    });
  });

  describe('CORNER', () => {
    it('handles entries with extra set to undefined', () => {
      const sink = createConsoleSink();
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      const entry: LogEntry = { level: 'info', service: 'test', message: 'no extra' };
      expect(() => sink(entry)).not.toThrow();

      stdout.mockRestore();
      stderr.mockRestore();
    });

    it('JSON.stringify errors in extra do not crash the sink', () => {
      const sink = createConsoleSink();
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      const circular: Record<string, unknown> = {};
      (circular as Record<string, unknown>).self = circular;

      expect(() =>
        sink({ level: 'info', service: 'test', message: 'circular', extra: circular }),
      ).not.toThrow();

      stdout.mockRestore();
      stderr.mockRestore();
    });
  });

  describe('EDGE', () => {
    it('is a valid LogSink (returns void synchronously)', () => {
      const sink = createConsoleSink();
      const result = sink({ level: 'info', service: 'test', message: 'edge' });
      expect(result).toBeUndefined();
    });
  });
});
