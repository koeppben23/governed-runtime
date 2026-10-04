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

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAppendFile,
  mockRename,
  mockStat,
  mockMkdir,
  actualStat,
  actualRename,
  statOutcomeBox,
  mkdirHookBox,
} = vi.hoisted(() => ({
  mockAppendFile: vi.fn(),
  mockRename: vi.fn(),
  mockStat: vi.fn(),
  mockMkdir: vi.fn(),
  actualStat: vi.fn(),
  actualRename: vi.fn(),
  statOutcomeBox: { current: null as number | Error | null },
  mkdirHookBox: { current: null as null | (() => Promise<void>) },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  actualRename.mockImplementation(actual.rename);
  mockRename.mockImplementation(actual.rename);
  actualStat.mockImplementation(actual.stat);
  mockStat.mockImplementation(async (filePath: unknown, ...rest: unknown[]) => {
    const outcome = statOutcomeBox.current;
    if (outcome !== null && String(filePath).endsWith('.log')) {
      if (outcome instanceof Error) throw outcome;
      return { size: outcome };
    }
    return (actualStat as (...args: unknown[]) => Promise<unknown>)(filePath, ...rest);
  });
  mockMkdir.mockImplementation(async (dir: unknown, options: unknown) => {
    const hook = mkdirHookBox.current;
    if (hook) {
      mkdirHookBox.current = null;
      await hook();
    }
    return (actual.mkdir as (...args: unknown[]) => Promise<unknown>)(dir, options);
  });
  return {
    ...actual,
    appendFile: mockAppendFile,
    rename: mockRename,
    stat: mockStat,
    mkdir: mockMkdir,
  };
});

import { mkdir, rm, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileSink } from './file-sink.js';
import { createLogger, type HealthAwareLogger } from './logger.js';

const ENTRY = { level: 'info' as const, service: 'test', message: 'message' };

/**
 * Route the stat override to log-file paths only. The sink probes the workspace
 * root with stat before its first write; that probe must observe the real
 * filesystem so these tests keep exercising delivery/rotation failures.
 */
function statOverrideForLogFile(outcome: number | Error): void {
  statOutcomeBox.current = outcome;
}

beforeEach(() => {
  statOutcomeBox.current = null;
  mkdirHookBox.current = null;
  mockAppendFile.mockReset();
  mockRename.mockReset();
  mockRename.mockImplementation(actualRename);
});

describe('file-sink failure propagation', () => {
  it('ENOSPC write failure rejects the sink and a later write can recover', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-enospc-'));
    const logDir = join(testDir, '.opencode', 'logs');
    await mkdir(logDir, { recursive: true });

    const err = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    mockAppendFile.mockRejectedValueOnce(err);

    try {
      const sink = createFileSink(testDir, { retentionDays: 1 });
      await expect(sink({ ...ENTRY, message: 'disk full' })).rejects.toBe(err);
      expect(mockAppendFile).toHaveBeenCalledTimes(1);

      mockAppendFile.mockResolvedValueOnce(undefined);
      statOverrideForLogFile(0);
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
    statOverrideForLogFile(10 * 1024 * 1024);
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
    statOverrideForLogFile(statErr);

    try {
      const sink = createFileSink(testDir, { retentionDays: 1, onFailure });
      await expect(sink({ ...ENTRY, message: 'stat boom' })).rejects.toBe(statErr);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0]![0]).toBe(statErr);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('does not recreate a workspace root that disappears after the probe', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-toctou-'));
    mkdirHookBox.current = async () => {
      // Root removal between the successful root probe and directory setup.
      await rm(testDir, { recursive: true, force: true });
    };

    try {
      const sink = createFileSink(testDir, { retentionDays: 1 });
      await expect(sink({ ...ENTRY, message: 'root race' })).rejects.toMatchObject({
        code: 'ENOENT',
      });
      // Non-recursive creation must not resurrect the workspace root.
      const exists = await stat(testDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
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

  it('a non-absolute workspace directory keeps the disabled-sink noop contract', async () => {
    const onFailure = vi.fn();
    mockAppendFile.mockClear();

    const sink = createFileSink('relative/workspace', { retentionDays: 1, onFailure });
    await expect(
      sink({ ...ENTRY, level: 'error', message: 'never lands on disk' }),
    ).resolves.not.toThrow();
    expect(onFailure).not.toHaveBeenCalled();
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
      await vi.waitFor(() => {
        expect((log as HealthAwareLogger).getHealth().sinkFailuresTotal).toBe(1);
      });
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
