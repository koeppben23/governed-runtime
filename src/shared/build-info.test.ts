import { afterEach, describe, expect, it, vi } from 'vitest';

describe('BUILD_INFO', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('returns the parsed build identity when build-info.json is present and valid', async () => {
    vi.doMock('node:fs', () => ({
      readFileSync: () =>
        JSON.stringify({
          version: '9.9.9-test.1',
          gitSha: 'deadbeef',
          gitShaSource: 'git',
          builtAt: '2026-06-23T00:00:00.000Z',
        }),
    }));
    const { BUILD_INFO } = await import('./build-info.js');
    expect(BUILD_INFO()).toEqual({
      version: '9.9.9-test.1',
      gitSha: 'deadbeef',
      gitShaSource: 'git',
      builtAt: '2026-06-23T00:00:00.000Z',
    });
  });

  it('caches across calls (single read)', async () => {
    let reads = 0;
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        reads += 1;
        return JSON.stringify({
          version: 'v',
          gitSha: 's',
          gitShaSource: 'git',
          builtAt: 'b',
        });
      },
    }));
    const { BUILD_INFO } = await import('./build-info.js');
    BUILD_INFO();
    BUILD_INFO();
    expect(reads).toBe(1);
  });

  it('returns null (diagnostic, never throws) when build-info.json is absent', async () => {
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        throw new Error('ENOENT');
      },
    }));
    const { BUILD_INFO } = await import('./build-info.js');
    expect(BUILD_INFO()).toBeNull();
  });

  it('returns null when build-info.json is malformed JSON', async () => {
    vi.doMock('node:fs', () => ({
      readFileSync: () => '{ not json',
    }));
    const { BUILD_INFO } = await import('./build-info.js');
    expect(BUILD_INFO()).toBeNull();
  });

  it('returns null when required fields are missing/typed wrong', async () => {
    vi.doMock('node:fs', () => ({
      readFileSync: () => JSON.stringify({ version: 1, gitSha: 'x' }),
    }));
    const { BUILD_INFO } = await import('./build-info.js');
    expect(BUILD_INFO()).toBeNull();
  });
});
