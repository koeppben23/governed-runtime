/**
 * @module discovery/drift-cancellation.test
 * @description Abort contracts at the discovery I/O boundary.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE.
 */
import { describe, expect, it, vi } from 'vitest';
import { checkDiscoveryDrift } from './drift.js';
import type { DiscoveryIoPort } from './io-port.js';

function makeIo(listRepoSignals: DiscoveryIoPort['listRepoSignals']): DiscoveryIoPort {
  return {
    readPersistedDiscovery: vi.fn(async () => null),
    listRepoSignals,
    defaultBranch: vi.fn(async () => 'develop'),
    headCommit: vi.fn(async () => 'commit'),
    isClean: vi.fn(async () => true),
    remoteOriginUrl: vi.fn(async () => null),
  };
}

describe('read-only discovery drift cancellation', () => {
  it('BAD: aborting a pending repository scan rejects and stops its I/O', async () => {
    const controller = new AbortController();
    let active = 0;
    const listRepoSignals = vi.fn(async (_root: string, signal?: AbortSignal) => {
      active += 1;
      try {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return { files: [], packageFilePaths: [], configFilePaths: [] };
      } finally {
        active -= 1;
      }
    });
    const io = makeIo(listRepoSignals);
    const pending = checkDiscoveryDrift(
      '/workspace',
      '/repo',
      'a'.repeat(24),
      io,
      controller.signal,
    );
    await vi.waitFor(() => expect(active).toBe(1));
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(active).toBe(0);
    expect(listRepoSignals).toHaveBeenCalledWith('/repo', controller.signal);
    expect(io.defaultBranch).not.toHaveBeenCalled();
  });

  it('EDGE: an already aborted signal never starts repository discovery', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before start'));
    const io = makeIo(
      vi.fn(async () => ({ files: [], packageFilePaths: [], configFilePaths: [] })),
    );
    await expect(
      checkDiscoveryDrift('/workspace', '/repo', 'a'.repeat(24), io, controller.signal),
    ).rejects.toThrow('cancelled before start');
    expect(io.readPersistedDiscovery).not.toHaveBeenCalled();
    expect(io.listRepoSignals).not.toHaveBeenCalled();
  });
});
