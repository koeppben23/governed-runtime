/**
 * Exact-host safety cases ported from the removed V1 compatibility classifier.
 * The current owner is the native acceptance resolver, not a warning-only
 * version classifier. Candidate selection never certifies ACTIVE or Desktop.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nativeOpenCodeCandidate,
  resolvePinnedOpenCodeHost,
} from './opencode-live-host-test-helpers.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn(), execFileSync: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

function probe(version: string | null) {
  vi.stubEnv('OPENCODE_CLI', '/probe/candidate-opencode');
  vi.mocked(spawnSync).mockReturnValue({ stdout: version, status: 0 } as ReturnType<
    typeof spawnSync
  >);
}

function bumped(bump: 'minor' | 'patch'): string {
  const [major, minor, patch] = nativeOpenCodeCandidate.version.split('.').map(Number);
  if (major === undefined || minor === undefined || patch === undefined)
    throw new Error('The candidate must contain an exact three-part version.');
  return bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

function rejects(version: string | null): void {
  probe(version);
  expect(() => resolvePinnedOpenCodeHost()).toThrow(
    expect.objectContaining({ code: 'OPENCODE_HOST_VERSION_MISMATCH' }),
  );
}

describe('current exact OpenCode candidate contract (nine ported cases)', () => {
  it('retires the old deny-list/classifier instead of retaining a compatibility runtime', () => {
    expect(existsSync(new URL('./opencode-runtime-compat.ts', import.meta.url))).toBe(false);
    expect(nativeOpenCodeCandidate.status).toBe('candidate');
    expect(nativeOpenCodeCandidate.package).toBe('@opencode/cli');
  });

  it('HAPPY: accepts exactly the current candidate without promoting it to product certification', () => {
    const version = `opencode v${nativeOpenCodeCandidate.version}`;
    probe(version);
    expect(resolvePinnedOpenCodeHost()).toMatchObject({
      command: '/probe/candidate-opencode',
      version,
    });
    expect(nativeOpenCodeCandidate.status).toBe('candidate');
  });

  it('BAD: rejects a newer patch in the same minor line, rather than warning and continuing', () => {
    rejects(`opencode v${bumped('patch')}`);
  });

  it('BAD: an older version never inherits exact-candidate acceptance', () => {
    rejects('opencode v1.15.13');
  });

  it('BAD: a newer minor never inherits exact-candidate acceptance', () => {
    rejects(`opencode v${bumped('minor')}`);
  });

  it('BAD: the formerly synthetic incompatible version is rejected without a deny-list adapter', () => {
    rejects('opencode v1.20.3');
  });

  it('CORNER: unknown or malformed versions fail closed', () => {
    rejects(null);
    rejects('not-a-version');
  });

  it('HAPPY: current candidate/API pins align while historical V1 evidence retains its original pin', () => {
    const sdk = JSON.parse(
      readFileSync(new URL('../../.sdk-baselines/opencode/version.json', import.meta.url), 'utf8'),
    );
    const historical = JSON.parse(
      readFileSync(
        new URL('../../.sdk-baselines/opencode/host-version.json', import.meta.url),
        'utf8',
      ),
    );
    expect(nativeOpenCodeCandidate.version).toBe(sdk.packages['@opencode/client']);
    expect(nativeOpenCodeCandidate.version).toBe(sdk.packages['@opencode/plugin']);
    expect(historical.version).toBe('1.19.5');
    expect(historical.package).toBe('opencode-ai');
    expect(historical.version).not.toBe(nativeOpenCodeCandidate.version);
  });

  it('EDGE: prerelease/nightly builds do not inherit exact-candidate acceptance', () => {
    rejects(`opencode v${nativeOpenCodeCandidate.version}-nightly.20260901`);
  });
});
