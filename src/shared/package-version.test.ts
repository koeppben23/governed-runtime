import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('PACKAGE_VERSION', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('reads the canonical VERSION file', async () => {
    const expected = readFileSync(new URL('../../VERSION', import.meta.url), 'utf-8').trim();
    const { PACKAGE_VERSION } = await import('./package-version.js');

    expect(PACKAGE_VERSION()).toBe(expected);
  });

  it('returns the cached version across multiple calls', async () => {
    let reads = 0;
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        reads += 1;
        return reads === 1 ? '9.9.9-test.1\n' : '0.0.0-drift\n';
      },
    }));

    const { PACKAGE_VERSION } = await import('./package-version.js');

    expect(PACKAGE_VERSION()).toBe('9.9.9-test.1');
    expect(PACKAGE_VERSION()).toBe('9.9.9-test.1');
    expect(reads).toBe(1);
  });

  it('fails explicitly when VERSION cannot be read', async () => {
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        throw new Error('missing');
      },
    }));

    const { PACKAGE_VERSION } = await import('./package-version.js');

    expect(() => PACKAGE_VERSION()).toThrow(/VERSION file not found at .+VERSION/);
  });
});
