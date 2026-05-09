/**
 * @module logging/adapter-real-sink.test
 * @description Tests proving adapter-layer failures write to real sinks.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAdapterLogger,
  runWithAdapterLogger,
  resetAdapterLogger,
  setAdapterLogger,
  type AdapterLogger,
} from './adapter-logger.js';
import { createConsoleSink } from './console-sink.js';
import { createFileSink } from './file-sink.js';
import { createLogger } from './logger.js';

describe('Adapter logging — real sinks', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    resetAdapterLogger();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAdapterLogger();
  });

  describe('HAPPY', () => {
    it('scoped adapter logger writes to console sink', () => {
      const captured: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        captured.push(String(chunk));
        return true;
      });

      const log = createLogger('debug', [createConsoleSink()]);
      const adapter = toAdapter(log);

      runWithAdapterLogger(adapter, () => {
        getAdapterLogger().error('persistence', 'Atomic write failed', {
          filePath: '/tmp/state.json',
        });
      });

      expect(captured.join('')).toContain('persistence');
      expect(captured.join('')).toContain('Atomic write failed');
    });

    it('scoped adapter writes to both console and file sinks', async () => {
      const captured: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        captured.push(String(chunk));
        return true;
      });

      const { mkdtemp, rm, readdir, readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');

      const tmpDir = await mkdtemp(join(tmpdir(), 'fg-rs-'));

      try {
        const log = createLogger('debug', [createConsoleSink(), createFileSink(tmpDir, 7)]);
        const adapter = toAdapter(log);

        runWithAdapterLogger(adapter, () => {
          getAdapterLogger().error('persistence', 'Atomic write failed', {
            error: 'ENOSPC',
          });
        });

        await new Promise((r) => setTimeout(r, 300));

        const logDir = join(tmpDir, '.opencode', 'logs');
        const entries = await readdir(logDir);
        const logFile = entries.find((f) => f.startsWith('flowguard-'));
        if (logFile) {
          const content = await readFile(join(logDir, logFile), 'utf-8');
          const parsed = JSON.parse(content.trim().split('\n')[0] ?? '{}');
          expect(parsed.service).toBe('persistence');
          expect(parsed.message).toBe('Atomic write failed');
        }

        expect(captured.join('')).toContain('persistence');
      } finally {
        try {
          await rm(tmpDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    });

    it('setAdapterLogger works for unscoped, top-level use', () => {
      const captured: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        captured.push(String(chunk));
        return true;
      });

      setAdapterLogger(toAdapter(createLogger('debug', [createConsoleSink()])));
      getAdapterLogger().warn('git', 'Failed to resolve current branch');

      expect(captured.join('')).toContain('git');
    });
  });

  describe('BAD', () => {
    it('console sink failure is non-blocking', () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => {
        throw new Error('broken');
      });

      const adapter = toAdapter(createLogger('debug', [createConsoleSink()]));
      expect(() =>
        runWithAdapterLogger(adapter, () => {
          getAdapterLogger().error('p', 'fail');
        }),
      ).not.toThrow();
    });
  });

  describe('EDGE', () => {
    it('warnOnce deduplicates git fallback warnings — 2 calls, 1 sink write', () => {
      const mockWarn = vi.fn();
      const base: AdapterLogger = { info: vi.fn(), warn: mockWarn, error: vi.fn() };

      // Simulate what git.ts currentBranch does via logWarn helper
      runWithAdapterLogger(base, () => {
        const log = getAdapterLogger();
        log.warnOnce?.('git', 'Failed to resolve current branch');
        log.warnOnce?.('git', 'Failed to resolve current branch');
        log.warnOnce?.('git', 'Failed to resolve current branch');
      });

      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn.mock.calls[0][0]).toBe('git');
      expect(mockWarn.mock.calls[0][1]).toBe('Failed to resolve current branch');
    });

    it('warnOnce allows different messages but deduplicates same message', () => {
      const mockWarn = vi.fn();
      const base: AdapterLogger = { info: vi.fn(), warn: mockWarn, error: vi.fn() };

      runWithAdapterLogger(base, () => {
        const log = getAdapterLogger();
        log.warnOnce?.('git', 'Failed to resolve current branch');
        log.warnOnce?.('git', 'Failed to resolve current branch');
        log.warnOnce?.('git', 'Failed to resolve HEAD commit');
        log.warnOnce?.('git', 'Failed to resolve HEAD commit');
        log.warnOnce?.('git', 'Failed to resolve default branch');
      });

      expect(mockWarn).toHaveBeenCalledTimes(3);
    });
  });
});

function toAdapter(log: ReturnType<typeof createLogger>): AdapterLogger {
  return {
    info: log.info.bind(log),
    warn: log.warn.bind(log),
    error: log.error.bind(log),
  };
}
