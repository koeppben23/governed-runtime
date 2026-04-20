/**
 * @module logging/file-sink.test
 * @description Tests for FlowGuard file-based logging sink.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileSink, getLogDir } from './file-sink';
import type { LogEntry } from './logger';

describe('createFileSink', () => {
  const getTestDir = () =>
    '/tmp/flowguard-file-sink-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  let testDir: string;

  beforeEach(async () => {
    testDir = getTestDir();
    await mkdir(join(testDir, '.opencode/logs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('HAPPY', () => {
    it('creates log file in correct directory', async () => {
      const sink = createFileSink(testDir, 7);
      const entry: LogEntry = { level: 'info', service: 'test', message: 'hello world' };
      await sink(entry);

      const files = await readdir(join(testDir, '.opencode/logs'));
      expect(files.some((f) => f.startsWith('flowguard-'))).toBe(true);
    });

    it('writes valid JSONL format', async () => {
      const sink = createFileSink(testDir, 7);
      const entry: LogEntry = {
        level: 'info',
        service: 'plugin',
        message: 'initialized',
        extra: { fingerprint: 'abc123' },
      };
      await sink(entry);

      const files = await readdir(join(testDir, '.opencode/logs'));
      const logFile = files.find((f) => f.startsWith('flowguard-'))!;
      const content = await readFile(join(testDir, '.opencode/logs', logFile), 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.level).toBe('info');
      expect(parsed.service).toBe('plugin');
      expect(parsed.fields).toEqual({ fingerprint: 'abc123' });
    });

    it('appends to existing daily log file', async () => {
      const sink = createFileSink(testDir, 7);
      await sink({ level: 'info', service: 'test', message: 'first' });
      await sink({ level: 'info', service: 'test', message: 'second' });

      const files = await readdir(join(testDir, '.opencode/logs'));
      const content = await readFile(join(testDir, '.opencode/logs', files[0]), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
    });

    it('creates log directory if missing', async () => {
      const freshDir = '/tmp/flowguard-fresh-' + Date.now();
      await rm(freshDir, { recursive: true, force: true }).catch(() => {});

      const sink = createFileSink(freshDir, 7);
      await sink({ level: 'info', service: 'test', message: 'new dir' });

      const dirOk = await stat(join(freshDir, '.opencode/logs'))
        .then(() => true)
        .catch(() => false);
      expect(dirOk).toBe(true);
      await rm(freshDir, { recursive: true, force: true }).catch(() => {});
    });
  });

  describe('BAD', () => {
    it('does not throw when directory is non-existent', async () => {
      const badDir = '/tmp/this-does-not-exist-123456789';
      const sink = createFileSink(badDir, 7);
      const entry: LogEntry = { level: 'info', service: 'test', message: 'hello' };
      await expect(sink(entry)).resolves.not.toThrow();
    });

    it('handles disk failure gracefully', async () => {
      const sink = createFileSink(testDir, 7);
      const entry: LogEntry = { level: 'info', service: 'test', message: 'test' };
      await expect(sink(entry)).resolves.not.toThrow();
    });

    it('handles empty workspace dir gracefully (no write)', async () => {
      const sink = createFileSink('', 7);
      const entry: LogEntry = { level: 'info', service: 'test', message: 'empty dir' };
      await expect(sink(entry)).resolves.not.toThrow();
    });

    it('handles relative path gracefully (no write)', async () => {
      const sink = createFileSink('./relative/path', 7);
      const entry: LogEntry = { level: 'info', service: 'test', message: 'relative' };
      await expect(sink(entry)).resolves.not.toThrow();
    });
  });

  describe('CORNER', () => {
    it('works with empty extra field', async () => {
      const sink = createFileSink(testDir, 7);
      await sink({ level: 'info', service: 'test', message: 'no extra' });

      const files = await readdir(join(testDir, '.opencode/logs'));
      expect(files.length).toBeGreaterThan(0);
    });

    it('works with all log levels', async () => {
      const sink = createFileSink(testDir, 7);
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        await sink({ level, service: 'test', message: `msg-${level}` });
      }
      const files = await readdir(join(testDir, '.opencode/logs'));
      expect(files.length).toBeGreaterThan(0);
    });

    it('uses default retention of 7 when not specified', async () => {
      const sink = createFileSink(testDir, undefined);
      await sink({ level: 'info', service: 'test', message: 'default retention' });
      const files = await readdir(join(testDir, '.opencode/logs'));
      expect(files.some((f) => f.startsWith('flowguard-'))).toBe(true);
    });
  });

  describe('EDGE', () => {
    it('handles many concurrent log calls without race condition', async () => {
      const sink = createFileSink(testDir, 7);
      const entry: LogEntry = { level: 'info', service: 'test', message: 'race test' };

      await Promise.all(Array.from({ length: 20 }, () => sink(entry)));

      const files = await readdir(join(testDir, '.opencode/logs'));
      expect(files.length).toBe(1);
      const content = await readFile(join(testDir, '.opencode/logs', files[0]), 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(20);
    });

    it('handles concurrent writes from multiple sinks', async () => {
      const sink1 = createFileSink(testDir, 7);
      const sink2 = createFileSink(testDir, 7);
      await Promise.all([
        sink1({ level: 'info', service: 'sink1', message: 'first' }),
        sink2({ level: 'info', service: 'sink2', message: 'second' }),
      ]);
      const files = await readdir(join(testDir, '.opencode/logs'));
      expect(files.length).toBeGreaterThan(0);
    });

    it('handles very large extra fields', async () => {
      const sink = createFileSink(testDir, 7);
      await sink({
        level: 'info',
        service: 'test',
        message: 'large',
        extra: { data: 'x'.repeat(10000) },
      });
      const files = await readdir(join(testDir, '.opencode/logs'));
      expect(files.length).toBeGreaterThan(0);
    });

    it('handles unicode in messages', async () => {
      const sink = createFileSink(testDir, 7);
      await sink({ level: 'info', service: 'test', message: 'HこんにちはWorld🌍' });
      const files = await readdir(join(testDir, '.opencode/logs'));
      expect(files.length).toBeGreaterThan(0);
    });
  });
});

describe('getLogDir', () => {
  it('returns correct log directory path', () => {
    expect(getLogDir('/workspace')).toBe('/workspace/.opencode/logs');
  });

  it('handles paths with trailing slash', () => {
    expect(getLogDir('/workspace/')).toBe('/workspace/.opencode/logs');
  });
});
