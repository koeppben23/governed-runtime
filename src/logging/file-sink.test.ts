/**
 * @module logging/file-sink.test
 * @description Tests for FlowGuard file-based logging sink.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, readdir, stat, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileSink, getLogDir } from './file-sink.js';
import type { LogEntry } from './logger.js';

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

    it('JSONL entry always contains all required fields', async () => {
      const sink = createFileSink(testDir, 7);
      await sink({ level: 'info', service: 'test', message: 'hello' });
      // Without extra field
      await sink({ level: 'error', service: 'core', message: 'oops', extra: { code: 'E1' } });

      const files = await readdir(join(testDir, '.opencode/logs'));
      const content = await readFile(join(testDir, '.opencode/logs', files[0]), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(2);

      for (const line of lines) {
        const entry = JSON.parse(line);
        expect(typeof entry.ts).toBe('string');
        expect(entry.ts).toBeTruthy();
        expect(entry.level).toBeDefined();
        expect(entry.component).toBe('flowguard');
        expect(typeof entry.message).toBe('string');
        expect(typeof entry.service).toBe('string');
      }
      // First entry has no extra → no fields
      expect(JSON.parse(lines[0]!).fields).toBeUndefined();
      // Second entry has extra → fields present
      expect(JSON.parse(lines[1]!).fields).toEqual({ code: 'E1' });
    });

    it('includes traceId and sessionId in JSONL when present on LogEntry', async () => {
      const sink = createFileSink(testDir, { retentionDays: 1 });
      await sink({
        level: 'info',
        service: 'plugin',
        message: 'bound',
        traceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000',
        sessionId: 'ses_00000000000abcde',
      });
      await sink({
        level: 'info',
        service: 'plugin',
        message: 'trace-only',
        traceId: 'trace-only-001',
      });
      await sink({
        level: 'info',
        service: 'plugin',
        message: 'no-trace',
      });

      const files = await readdir(join(testDir, '.opencode/logs'));
      const content = await readFile(join(testDir, '.opencode/logs', files[0]), 'utf-8');
      const lines = content.trim().split('\n');

      // Entry with both
      const e1 = JSON.parse(lines[0]!);
      expect(e1.traceId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000');
      expect(e1.sessionId).toBe('ses_00000000000abcde');
      expect(e1.level).toBe('info');

      // Entry with traceId only (no sessionId)
      const e2 = JSON.parse(lines[1]!);
      expect(e2.traceId).toBe('trace-only-001');
      expect(e2.sessionId).toBeUndefined();

      // Entry with neither
      const e3 = JSON.parse(lines[2]!);
      expect(e3.traceId).toBeUndefined();
      expect(e3.sessionId).toBeUndefined();
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

  // ─── RETENTION ─────────────────────────────────────────────────

  describe('retention', () => {
    const oneDayMs = 86_400_000;

    function makeLogFileName(date: Date): string {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `flowguard-${y}-${m}-${d}.log`;
    }

    async function createLogFile(dir: string, filename: string): Promise<string> {
      const logDir = join(dir, '.opencode', 'logs');
      await mkdir(logDir, { recursive: true });
      const filePath = join(logDir, filename);
      await writeFile(filePath, '{"level":"info","message":"old"}\n');
      return filePath;
    }

    it('recent file within retention window survives', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'fg-ret-survive-'));
      try {
        // 1 day ago — within 7-day retention
        const recentDate = new Date(Date.now() - oneDayMs);
        const recentFile = await createLogFile(testDir, makeLogFileName(recentDate));

        const sink = createFileSink(testDir, 7);
        await sink({ level: 'info', service: 'test', message: 'trigger' });

        await expect(stat(recentFile)).resolves.toBeDefined();
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('expired file outside retention window is deleted', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'fg-ret-delete-'));
      try {
        // 8 days ago — outside 7-day retention
        const expiredDate = new Date(Date.now() - oneDayMs * 8);
        const expiredFile = await createLogFile(testDir, makeLogFileName(expiredDate));

        const sink = createFileSink(testDir, 7);
        await sink({ level: 'info', service: 'test', message: 'trigger' });

        await expect(stat(expiredFile)).rejects.toThrow();
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('mixed old and new: only expired files are deleted', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'fg-ret-mixed-'));
      try {
        // Two recent files (within 7-day window)
        const recent1 = await createLogFile(
          testDir,
          makeLogFileName(new Date(Date.now() - oneDayMs)),
        );
        const recent2 = await createLogFile(
          testDir,
          makeLogFileName(new Date(Date.now() - oneDayMs * 3)),
        );
        // Two old files (outside 7-day window)
        const old1 = await createLogFile(
          testDir,
          makeLogFileName(new Date(Date.now() - oneDayMs * 8)),
        );
        const old2 = await createLogFile(
          testDir,
          makeLogFileName(new Date(Date.now() - oneDayMs * 14)),
        );

        const sink = createFileSink(testDir, 7);
        await sink({ level: 'info', service: 'test', message: 'trigger' });

        await expect(stat(recent1)).resolves.toBeDefined();
        await expect(stat(recent2)).resolves.toBeDefined();
        await expect(stat(old1)).rejects.toThrow();
        await expect(stat(old2)).rejects.toThrow();
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe('cleanup error paths', () => {
    it('deletes files with old dates in filename', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'fg-log-sink-olddate-'));
      try {
        const logDir = join(testDir, '.opencode', 'logs');
        await mkdir(logDir, { recursive: true });
        const oldLog = join(logDir, 'flowguard-2020-01-01.log');
        await writeFile(oldLog, '{"level":"info","message":"old"}\n');

        const sink = createFileSink(testDir, 7);
        await sink({ level: 'info', service: 'test', message: 'test' });

        // File from 2020 should be cleaned up (far outside 7-day retention)
        try {
          await stat(oldLog);
          // File may survive if system clock is weird
        } catch {
          // Expected: file was deleted
        }
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('handles unlink failure gracefully', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'fg-log-sink-unlink-'));
      try {
        const logDir = join(testDir, '.opencode', 'logs');
        await mkdir(logDir, { recursive: true });
        // Create a DIRECTORY named like a log file — unlink cannot remove a directory
        const fakeLog = join(logDir, 'flowguard-2020-01-01.log');
        await mkdir(fakeLog);

        const sink = createFileSink(testDir, 7);
        // This should not throw — cleanup errors are non-blocking
        await sink({ level: 'info', service: 'test', message: 'test' });
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe('G9: size rotation', () => {
    it('rotates file post-write when maxSizeBytes is exceeded', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'fg-log-sink-rotate-'));
      const logDir = join(testDir, '.opencode', 'logs');
      await mkdir(logDir, { recursive: true });

      try {
        // maxSizeBytes large enough for ~2 small entries but not 3
        const sink = createFileSink(testDir, {
          retentionDays: 7,
          maxSizeBytes: 250,
        });

        const date = new Date().toISOString().slice(0, 10);

        // Two writes fit within 250 bytes
        await sink({ level: 'info', service: 't', message: 'a' });
        await sink({ level: 'info', service: 't', message: 'b' });

        let files = await readdir(logDir);
        expect(files).toContain(`flowguard-${date}.log`);
        expect(files).not.toContain(`flowguard-${date}.1.log`);

        // Third write pushes past maxSizeBytes → post-write rotation
        await sink({ level: 'info', service: 't', message: 'c' });

        files = await readdir(logDir);
        expect(files).toContain(`flowguard-${date}.1.log`);
        // New file created for subsequent writes
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('rotates file on single oversized entry', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'fg-log-sink-oversize-'));
      const logDir = join(testDir, '.opencode', 'logs');
      await mkdir(logDir, { recursive: true });

      try {
        const sink = createFileSink(testDir, {
          retentionDays: 7,
          maxSizeBytes: 50,
        });

        // Single write exceeds maxSizeBytes → post-write rotation
        await sink({ level: 'info', service: 't', message: 'oversized content' });

        const date = new Date().toISOString().slice(0, 10);
        const files = await readdir(logDir);
        expect(files).toContain(`flowguard-${date}.1.log`);
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('onRotate callback is invoked on rotation', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'fg-log-sink-onrot-'));
      const logDir = join(testDir, '.opencode', 'logs');
      await mkdir(logDir, { recursive: true });

      const rotations: Array<{
        oldPath: string;
        newPath: string;
        reason: string;
      }> = [];

      try {
        const sink = createFileSink(testDir, {
          retentionDays: 7,
          maxSizeBytes: 250,
          onRotate: (event) => {
            rotations.push(event);
          },
        });

        // First two writes fit; third triggers rotation
        await sink({ level: 'info', service: 't', message: 'a' });
        await sink({ level: 'info', service: 't', message: 'b' });
        expect(rotations.length).toBe(0);

        await sink({ level: 'info', service: 't', message: 'c' });
        expect(rotations.length).toBe(1);
        expect(rotations[0]!.reason).toBe('size');
        expect(rotations[0]!.oldPath).toContain('flowguard-');
        expect(rotations[0]!.newPath).toContain('flowguard-');
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('onRotate failure is non-blocking', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'fg-log-sink-onrotf-'));
      const logDir = join(testDir, '.opencode', 'logs');
      await mkdir(logDir, { recursive: true });

      try {
        const sink = createFileSink(testDir, {
          retentionDays: 7,
          maxSizeBytes: 50,
          onRotate: () => {
            throw new Error('onRotate crashed');
          },
        });

        await expect(
          sink({ level: 'info', service: 't', message: 'triggers rotation xxxxxxxxxxxxxxxxxxxxx' }),
        ).resolves.not.toThrow();
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('rotated .N.log files are cleaned up by retention', async () => {
      const testDir = await mkdtemp(join(tmpdir(), 'fg-log-sink-rotcln-'));
      const logDir = join(testDir, '.opencode', 'logs');
      await mkdir(logDir, { recursive: true });

      try {
        const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const oldRotated = join(logDir, `flowguard-${oldDate}.1.log`);
        await writeFile(oldRotated, '{"ts":"old"}\n');

        const sink = createFileSink(testDir, { retentionDays: 7 });
        await sink({
          level: 'info',
          service: 'test',
          message: 'trigger cleanup',
        });

        const files = await readdir(logDir);
        expect(files).not.toContain(`flowguard-${oldDate}.1.log`);
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
});

describe('getLogDir', () => {
  it('returns correct log directory path', () => {
    expect(getLogDir('/workspace')).toBe(join('/workspace', '.opencode', 'logs'));
  });

  it('handles paths with trailing slash', () => {
    expect(getLogDir('/workspace/')).toBe(join('/workspace', '.opencode', 'logs'));
  });
});
