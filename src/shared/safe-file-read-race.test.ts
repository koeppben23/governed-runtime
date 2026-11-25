/** Deterministic race controls for the canonical bounded reader. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lstat: vi.fn(), open: vi.fn() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: mocks.lstat, open: mocks.open };
});

import { readRegularFileBounded } from './safe-file-read.js';

function stat(identity: { dev?: number; ino?: number; size?: number; symlink?: boolean } = {}) {
  return {
    dev: identity.dev ?? 1,
    ino: identity.ino ?? 2,
    size: identity.size ?? 4,
    isFile: () => true,
    isSymbolicLink: () => identity.symlink === true,
  };
}

function handle(identity: { dev?: number; ino?: number; size?: number }, chunks: Buffer[]) {
  return {
    stat: async () => stat(identity),
    read: async (buffer: Buffer, offset: number, length: number) => {
      const chunk = chunks.shift() ?? Buffer.alloc(0);
      const bytesRead = Math.min(chunk.length, length);
      chunk.copy(buffer, offset, 0, bytesRead);
      return { bytesRead };
    },
    close: vi.fn(async () => undefined),
  };
}

describe('safe-file-read race controls', () => {
  beforeEach(() => {
    mocks.lstat.mockReset();
    mocks.open.mockReset();
  });

  it('rejects growth between fstat and the bounded read', async () => {
    mocks.lstat.mockResolvedValue(stat({ size: 4 }));
    mocks.open.mockResolvedValue(handle({ size: 4 }, [Buffer.from('abcdef')]));

    await expect(readRegularFileBounded('/fixture/grow', { maxBytes: 4 })).rejects.toMatchObject({
      code: 'OVERSIZED',
      bytes: 5,
    });
  });

  it('rejects a file replaced between path validation and opening', async () => {
    mocks.lstat.mockResolvedValue(stat({ dev: 1, ino: 2 }));
    mocks.open.mockResolvedValue(handle({ dev: 1, ino: 3 }, [Buffer.from('data')]));

    await expect(
      readRegularFileBounded('/fixture/replaced', { maxBytes: 16 }),
    ).rejects.toMatchObject({ code: 'CHANGED' });
  });
});
