/**
 * @module logging/file-sink-failure.test
 * @description Tests for file-sink write failure handling (ENOSPC, EACCES).
 *
 * Uses vi.mock to intercept node:fs/promises.appendFile while preserving
 * all other fs functions. This tests the "logging errors never fail the flow"
 * contract when the underlying filesystem fails.
 *
 * @test-policy BAD
 * @version v2
 */

import { describe, it, expect, vi } from 'vitest';

const { mockAppendFile, mockRename, mockStat } = vi.hoisted(() => ({
  mockAppendFile: vi.fn(),
  mockRename: vi.fn(),
  mockStat: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  // Default to the real implementations; individual tests opt in to failures.
  mockRename.mockImplementation(actual.rename);
  mockStat.mockImplementation(actual.stat);
  return { ...actual, appendFile: mockAppendFile, rename: mockRename, stat: mockStat };
});

import { mkdir, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileSink } from './file-sink.js';

describe('file-sink write failure', () => {
  it('ENOSPC write failure does not crash sink', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-enospc-'));
    const logDir = join(testDir, '.opencode', 'logs');
    await mkdir(logDir, { recursive: true });

    const err = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    mockAppendFile.mockRejectedValueOnce(err);

    try {
      const sink = createFileSink(testDir, 1);
      // First write fails with ENOSPC — swallowed, no throw
      await expect(
        sink({ level: 'info', service: 'test', message: 'disk full' }),
      ).resolves.not.toThrow();
      expect(mockAppendFile).toHaveBeenCalledTimes(1);

      // Second write succeeds — sink recovery after ENOSPC
      mockAppendFile.mockResolvedValueOnce(undefined);
      await expect(
        sink({ level: 'info', service: 'test', message: 'recovered' }),
      ).resolves.not.toThrow();
      expect(mockAppendFile).toHaveBeenCalledTimes(2);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('invokes onFailure with the error on a write failure (observable, not silent)', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-onfail-'));
    await mkdir(join(testDir, '.opencode', 'logs'), { recursive: true });
    const onFailure = vi.fn();
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mockAppendFile.mockRejectedValueOnce(err);

    try {
      const sink = createFileSink(testDir, { retentionDays: 1, onFailure });
      await expect(
        sink({ level: 'error', service: 'test', message: 'cannot write' }),
      ).resolves.not.toThrow();
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0]![0]).toBe(err);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a throwing onFailure never propagates out of the sink', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-onfail-throw-'));
    await mkdir(join(testDir, '.opencode', 'logs'), { recursive: true });
    const onFailure = vi.fn(() => {
      throw new Error('onFailure boom');
    });
    mockAppendFile.mockRejectedValueOnce(new Error('disk error'));

    try {
      const sink = createFileSink(testDir, { retentionDays: 1, onFailure });
      await expect(sink({ level: 'error', service: 'test', message: 'x' })).resolves.not.toThrow();
      expect(onFailure).toHaveBeenCalledTimes(1);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a persistent rename (rotation) failure is surfaced via onFailure, not silent', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-rotate-fail-'));
    await mkdir(join(testDir, '.opencode', 'logs'), { recursive: true });
    const onFailure = vi.fn();

    // Write "succeeds" (mocked), stat reports over-size to trigger rotation,
    // rename fails — the live file stays in place and would grow unbounded.
    mockAppendFile.mockResolvedValueOnce(undefined);
    mockStat.mockResolvedValueOnce({ size: 10 * 1024 * 1024 } as unknown as Awaited<
      ReturnType<typeof import('node:fs/promises').stat>
    >);
    const renameErr = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    mockRename.mockRejectedValueOnce(renameErr);

    try {
      // maxSizeBytes = 1 MiB so the faked 10 MiB stat exceeds it.
      const sink = createFileSink(testDir, {
        retentionDays: 1,
        maxSizeBytes: 1024 * 1024,
        onFailure,
      });
      await expect(
        sink({ level: 'info', service: 'test', message: 'rotate me' }),
      ).resolves.not.toThrow();
      expect(mockRename).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0]![0]).toBe(renameErr);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a stat failure during rotation check is surfaced via onFailure, not silent', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'fg-fs-stat-fail-'));
    await mkdir(join(testDir, '.opencode', 'logs'), { recursive: true });
    const onFailure = vi.fn();

    mockAppendFile.mockResolvedValueOnce(undefined);
    const statErr = Object.assign(new Error('io error'), { code: 'EIO' });
    mockStat.mockRejectedValueOnce(statErr);

    try {
      const sink = createFileSink(testDir, { retentionDays: 1, onFailure });
      await expect(
        sink({ level: 'info', service: 'test', message: 'stat boom' }),
      ).resolves.not.toThrow();
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0]![0]).toBe(statErr);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
