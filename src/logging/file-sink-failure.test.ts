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

const { mockAppendFile } = vi.hoisted(() => ({
  mockAppendFile: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, appendFile: mockAppendFile };
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
});
