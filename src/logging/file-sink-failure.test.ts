/**
 * @module logging/file-sink-failure.test
 * @description Tests for file-sink failure handling and central health propagation.
 *
 * Uses vi.mock to intercept node:fs/promises operations while preserving
 * all other fs functions. Direct sink calls reject on delivery/rotation failure;
 * createLogger remains non-blocking and accounts those rejections in health.
 *
 * @test-policy BAD
 * @version v3
 */

import { describe, it, expect, vi } from 'vitest';

const { mockAppendFile, mockRename, mockStat } = vi.hoisted(() => ({
  mockAppendFile: vi.fn(),
  mockRename: vi.fn(),
  mockStat: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  mockRename.mockImplementation(actual.rename);
  mockStat.mockImplementation(actual.stat);
  return { ...actual, appendFile: mockAppendFile, rename: mockRename, stat: mockStat };
});

import { mkdir, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileSink } from './file-sink.js';
import { createLogger, type HealthAwareLogger } from './logger.js';

const ENTRY = { level: 'info' as const, service: 'test', message: 'message' };

describe('file-sink failure propagation', () => {
  it('ENOSPC write failure rejects the sink and a later write can recover', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-enospc-'));
    const logDir = join(testDir, '.opencode', 'logs');
    await mkdir(logDir, { recursive: true });

    const err = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    mockAppendFile.mockRejectedValueOnce(err);

    try {
      const sink = createFileSink(testDir, 1);
      await expect(sink({ ...ENTRY, message: 'disk full' })).rejects.toBe(err);
      expect(mockAppendFile).toHaveBeenCalledTimes(1);

      mockAppendFile.mockResolvedValueOnce(undefined);
      await expect(sink({ ...ENTRY, message: 'recovered' })).resolves.not.toThrow();
      expect(mockAppendFile).toHaveBeenCalledTimes(2);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('invokes onFailure with the original error and rejects that same error', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-onfail-'));
    await mkdir(join(testDir, '.opencode', 'logs'), { recursive: true });
    const onFailure = vi.fn();
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mockAppendFile.mockRejectedValueOnce(err);

    try {
      const sink = createFileSink(testDir, { retentionDays: 1, onFailure });
      await expect(sink({ ...ENTRY, level: 'error', message: 'cannot write' })).rejects.toBe(err);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0]![0]).toBe(err);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a throwing onFailure never replaces the original sink failure', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-onfail-throw-'));
    await mkdir(join(testDir, '.opencode', 'logs'), { recursive: true });
    const onFailure = vi.fn(() => {
      throw new Error('onFailure boom');
    });
    const diskError = new Error('disk error');
    mockAppendFile.mockRejectedValueOnce(diskError);

    try {
      const sink = createFileSink(testDir, { retentionDays: 1, onFailure });
      await expect(sink({ ...ENTRY, level: 'error' })).rejects.toBe(diskError);
      expect(onFailure).toHaveBeenCalledTimes(1);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a persistent rename failure rejects and is surfaced via onFailure', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-rotate-fail-'));
    await mkdir(join(testDir, '.opencode', 'logs'), { recursive: true });
    const onFailure = vi.fn();

    mockAppendFile.mockResolvedValueOnce(undefined);
    mockStat.mockResolvedValueOnce({ size: 10 * 1024 * 1024 } as unknown as Awaited<
      ReturnType<typeof import('node:fs/promises').stat>
    >);
    const renameErr = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    mockRename.mockRejectedValueOnce(renameErr);

    try {
      const sink = createFileSink(testDir, {
        retentionDays: 1,
        maxSizeBytes: 1024 * 1024,
        onFailure,
      });
      await expect(sink({ ...ENTRY, message: 'rotate me' })).rejects.toBe(renameErr);
      expect(mockRename).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0]![0]).toBe(renameErr);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a stat failure during rotation check rejects and is surfaced via onFailure', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-stat-fail-'));
    await mkdir(join(testDir, '.opencode', 'logs'), { recursive: true });
    const onFailure = vi.fn();

    mockAppendFile.mockResolvedValueOnce(undefined);
    const statErr = Object.assign(new Error('io error'), { code: 'EIO' });
    mockStat.mockRejectedValueOnce(statErr);

    try {
      const sink = createFileSink(testDir, { retentionDays: 1, onFailure });
      await expect(sink({ ...ENTRY, message: 'stat boom' })).rejects.toBe(statErr);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0]![0]).toBe(statErr);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a log-directory creation failure rejects instead of looking successful', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-mkdir-fail-'));
    const onFailure = vi.fn();
    mockAppendFile.mockClear();
    await writeFile(join(testDir, '.opencode'), 'not a directory', 'utf8');

    try {
      const sink = createFileSink(testDir, { retentionDays: 1, onFailure });
      await expect(
        sink({ ...ENTRY, level: 'error', message: 'never lands on disk' }),
      ).rejects.toBeInstanceOf(Error);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect(mockAppendFile).not.toHaveBeenCalled();
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a non-absolute workspace directory rejects and is surfaced via onFailure', async () => {
    const onFailure = vi.fn();
    mockAppendFile.mockClear();

    const sink = createFileSink('relative/workspace', { retentionDays: 1, onFailure });
    await expect(
      sink({ ...ENTRY, level: 'error', message: 'never lands on disk' }),
    ).rejects.toThrow('absolute');
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect((onFailure.mock.calls[0]![0] as Error).message).toContain('absolute');
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it('createLogger counts a file-sink rejection while keeping logging non-blocking', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-health-'));
    await mkdir(join(testDir, '.opencode', 'logs'), { recursive: true });
    const err = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    mockAppendFile.mockRejectedValueOnce(err);

    try {
      const log = createLogger('debug', [createFileSink(testDir)]);
      expect(() => log.info('test', 'health probe')).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((log as HealthAwareLogger).getHealth().sinkFailuresTotal).toBe(1);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
