/** The activation wait retries only the pinned host's transient activation answer. */
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitLocationActivation, nativeNodeCommand } from './opencode-native-test-helpers.js';

describe('nativeNodeCommand', () => {
  it('runs unchanged in the platform shell the host uses for shell tools', () => {
    const dir = mkdtempSync(join(tmpdir(), "fg-native-cmd-'quote "));
    try {
      const target = join(dir, 'effect.txt');
      const command = nativeNodeCommand(
        `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'native-effect')`,
      );
      if (process.platform === 'win32')
        execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command]);
      else execFileSync('bash', ['-c', command]);
      expect(readFileSync(target, 'utf8')).toBe('native-effect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const location = { directory: '/project' };
const activating = {
  _tag: 'ServiceUnavailableError',
  message: 'Location plugins did not finish activating',
};

function clientFailing(...failures: unknown[]) {
  const list = vi.fn(async () => {
    const next = failures.shift();
    if (next !== undefined) throw next;
    return { data: [] };
  });
  return { client: { agent: { list } } as never, list };
}

describe('awaitLocationActivation', () => {
  it('returns at once when the location is already active', async () => {
    const { client, list } = clientFailing();
    await expect(awaitLocationActivation(client, location, 1_000, 0)).resolves.toBe(0);
    expect(list).toHaveBeenCalledOnce();
  });

  it('retries the transient activation answer and reports the deferrals', async () => {
    const { client, list } = clientFailing(activating, activating);
    await expect(awaitLocationActivation(client, location, 1_000, 0)).resolves.toBe(2);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['another unavailable service', { _tag: 'ServiceUnavailableError', message: 'Shutting down' }],
    ['a different host error', { _tag: 'LocationNotFoundError', message: 'missing' }],
    ['a transport error', new Error('connection refused')],
  ])('rethrows %s unchanged', async (_name, failure) => {
    const { client, list } = clientFailing(failure);
    await expect(awaitLocationActivation(client, location, 1_000, 0)).rejects.toBe(failure);
    expect(list).toHaveBeenCalledOnce();
  });

  it('stops at the overall deadline instead of retrying forever', async () => {
    const list = vi.fn(async () => {
      throw activating;
    });
    await expect(
      awaitLocationActivation({ agent: { list } } as never, location, 50, 20),
    ).rejects.toBe(activating);
    expect(list.mock.calls.length).toBeGreaterThan(1);
  });
});
