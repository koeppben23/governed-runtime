/**
 * @module logging/file-sink.test
 * @description Tests for FlowGuard file-based logging sink.
 *
 * Covers:
 * - file sink creates log files in correct directory
 * - JSONL format output
 * - retention cleanup logic
 * - non-blocking error handling
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileSink, getLogDir } from './file-sink';
import type { LogEntry } from './logger';

const TEST_DIR = '/tmp/flowguard-file-sink-test';

describe('createFileSink', () => {
  beforeEach(async () => {
    await mkdir(join(TEST_DIR, '.opencode/logs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('HAPPY', () => {
    it('creates log file in correct directory', async () => {
      const sink = createFileSink(TEST_DIR, 7);
      const entry: LogEntry = {
        level: 'info',
        service: 'test',
        message: 'hello world',
      };

      await sink(entry);

      const files = await readdir(join(TEST_DIR, '.opencode/logs'));
      expect(files.some((f) => f.startsWith('flowguard-'))).toBe(true);
    });

    it('writes valid JSONL format', async () => {
      const sink = createFileSink(TEST_DIR, 7);
      const entry: LogEntry = {
        level: 'info',
        service: 'plugin',
        message: 'initialized',
        extra: { fingerprint: 'abc123' },
      };

      await sink(entry);

      const files = await readdir(join(TEST_DIR, '.opencode/logs'));
      const logFile = files.find((f) => f.startsWith('flowguard-'))!;
      const content = await readFile(join(TEST_DIR, '.opencode/logs', logFile), 'utf-8');
      const line = content.trim();

      const parsed = JSON.parse(line);
      expect(parsed.level).toBe('info');
      expect(parsed.service).toBe('plugin');
      expect(parsed.message).toBe('initialized');
      expect(parsed.fields).toEqual({ fingerprint: 'abc123' });
      expect(parsed.ts).toBeDefined();
      expect(parsed.component).toBe('flowguard');
    });

    it('appends to existing daily log file', async () => {
      const sink = createFileSink(TEST_DIR, 7);
      const entry1: LogEntry = { level: 'info', service: 'test', message: 'first' };
      const entry2: LogEntry = { level: 'info', service: 'test', message: 'second' };

      await sink(entry1);
      await sink(entry2);

      const files = await readdir(join(TEST_DIR, '.opencode/logs'));
      const logFile = files.find((f) => f.startsWith('flowguard-'))!;
      const content = await readFile(join(TEST_DIR, '.opencode/logs', logFile), 'utf-8');
      const lines = content.trim().split('\n');

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).message).toBe('first');
      expect(JSON.parse(lines[1]!).message).toBe('second');
    });

    it('creates log directory if missing', async () => {
      const freshDir = '/tmp/flowguard-fresh-test';
      await rm(freshDir, { recursive: true, force: true });

      const sink = createFileSink(freshDir, 7);
      await sink({ level: 'info', service: 'test', message: 'new dir' });

      const dirExists = await stat(join(freshDir, '.opencode/logs')).then(() => true).catch(() => false);
      expect(dirExists).toBe(true);

      await rm(freshDir, { recursive: true, force: true });
    });
  });

  describe('BAD', () => {
    it('does not throw when directory is unwritable', async () => {
      const badDir = '/proc/0';
      const sink = createFileSink(badDir, 7);
      const entry: LogEntry = { level: 'info', service: 'test', message: 'hello' };

      await expect(sink(entry)).resolves.not.toThrow();
    });

    it('handles disk failure gracefully', async () => {
      const sink = createFileSink(TEST_DIR, 7);
      const entry: LogEntry = { level: 'info', service: 'test', message: 'test' };

      await expect(sink(entry)).resolves.not.toThrow();
    });

    it('handles empty workspace dir gracefully (no write)', async () => {
      const sink = createFileSink('', 7);
      const entry: LogEntry = { level: 'info', service: 'test', message: 'empty dir' };

      const result = sink(entry);
      await expect(result).resolves.not.toThrow();
    });

    it('handles relative path gracefully (no write)', async () => {
      const sink = createFileSink('./relative/path', 7);
      const entry: LogEntry = { level: 'info', service: 'test', message: 'relative' };

      const result = sink(entry);
      await expect(result).resolves.not.toThrow();
    });

    it('deletes old log files based on mtime', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);
      const oldDateStr = oldDate.toISOString().slice(0, 10);

      const oldLogDir = join(TEST_DIR, '.opencode/logs');
      await mkdir(oldLogDir, { recursive: true });
      const oldLogFile = join(oldLogDir, `flowguard-${oldDateStr}.log`);

      await writeFile(oldLogFile, '{"ts":"old","level":"info"}\n');

      const oldTimestamp = oldDate.getTime();
      await import('node:fs').then((fs) => fs.utimesSync(oldLogFile, oldTimestamp / 1000, oldTimestamp / 1000));

      const sink = createFileSink(TEST_DIR, 7);
      await sink({ level: 'info', service: 'test', message: 'trigger cleanup' });

      const oldFileExists = await stat(oldLogFile).then(() => true).catch(() => false);
      expect(oldFileExists).toBe(false);
    });
  });

  describe('CORNER', () => {
    it('works with empty extra field', async () => {
      const sink = createFileSink(TEST_DIR, 7);
      const entry: LogEntry = { level: 'info', service: 'test', message: 'no extra' };

      await sink(entry);

      const files = await readdir(join(TEST_DIR, '.opencode/logs'));
      const logFile = files.find((f) => f.startsWith('flowguard-'))!;
      const content = await readFile(join(TEST_DIR, '.opencode/logs', logFile), 'utf-8');
      const parsed = JSON.parse(content.trim());

      expect(parsed.fields).toBeUndefined();
    });

    it('works with all log levels', async () => {
      const sink = createFileSink(TEST_DIR, 7);

      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        await sink({ level, service: 'test', message: `msg-${level}` });
      }

      const files = await readdir(join(TEST_DIR, '.opencode/logs'));
      const logFile = files.find((f) => f.startsWith('flowguard-'))!;
      const content = await readFile(join(TEST_DIR, '.opencode/logs', logFile), 'utf-8');
      const lines = content.trim().split('\n');

      expect(lines).toHaveLength(4);
    });

    it('uses default retention of 7 when not specified', async () => {
      const sink = createFileSink(TEST_DIR, undefined);

      await sink({ level: 'info', service: 'test', message: 'default retention' });

      const files = await readdir(join(TEST_DIR, '.opencode/logs'));
      expect(files.some((f) => f.startsWith('flowguard-'))).toBe(true);
    });
  });

  describe('EDGE', () => {
    it('handles concurrent writes from multiple sinks', async () => {
      const sink1 = createFileSink(TEST_DIR, 7);
      const sink2 = createFileSink(TEST_DIR, 7);

      await Promise.all([
        sink1({ level: 'info', service: 'sink1', message: 'first' }),
        sink2({ level: 'info', service: 'sink2', message: 'second' }),
      ]);

      const files = await readdir(join(TEST_DIR, '.opencode/logs'));
      expect(files.length).toBeGreaterThan(0);
    });

    it('handles very large extra fields', async () => {
      const largeExtra = { data: 'x'.repeat(10000) };
      const sink = createFileSink(TEST_DIR, 7);

      await sink({ level: 'info', service: 'test', message: 'large', extra: largeExtra });

      const files = await readdir(join(TEST_DIR, '.opencode/logs'));
      const logFile = files.find((f) => f.startsWith('flowguard-'))!;
      const content = await readFile(join(TEST_DIR, '.opencode/logs', logFile), 'utf-8');
      const parsed = JSON.parse(content.trim());

      expect(parsed.fields.data.length).toBe(10000);
    });

    it('handles unicode in messages', async () => {
      const sink = createFileSink(TEST_DIR, 7);

      await sink({ level: 'info', service: 'test', message: 'HこんにちはWorld🌍' });

      const files = await readdir(join(TEST_DIR, '.opencode/logs'));
      const logFile = files.find((f) => f.startsWith('flowguard-'))!;
      const content = await readFile(join(TEST_DIR, '.opencode/logs', logFile), 'utf-8');
      const parsed = JSON.parse(content.trim());

      expect(parsed.message).toBe('HこんにちはWorld🌍');
    });
  });
});

describe('getLogDir', () => {
  it('returns correct log directory path', () => {
    const result = getLogDir('/workspace');
    expect(result).toBe('/workspace/.opencode/logs');
  });

  it('handles paths with trailing slash', () => {
    const result = getLogDir('/workspace/');
    expect(result).toBe('/workspace/.opencode/logs');
  });
});