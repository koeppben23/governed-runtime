/**
 * @module cli/opencode-live-host.test
 * @description Unit coverage for the private filesystem boundary of real-host smoke probes.
 *
 * @test-policy HAPPY, CORNER — parallel hosts must not share mutable OpenCode paths.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIsolatedOpenCodeEnvironment,
  nativeOpenCodeCandidate,
  resolvePinnedOpenCodeHost,
  type PinnedOpenCodeHost,
} from './opencode-live-host-test-helpers.js';

const host: PinnedOpenCodeHost = {
  command: 'opencode',
  argsPrefix: [],
  version: `opencode v${nativeOpenCodeCandidate.version}`,
  env: {},
};

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

function versionProbe(stdout: string, status = 0) {
  vi.mocked(spawnSync).mockReturnValue({ stdout, status } as ReturnType<typeof spawnSync>);
}

describe('native candidate host resolver', () => {
  it('keeps the candidate pin aligned with the SDK without promoting historical host evidence', () => {
    const sdk = JSON.parse(
      readFileSync(new URL('../../.sdk-baselines/opencode/version.json', import.meta.url), 'utf8'),
    );
    expect(nativeOpenCodeCandidate).toMatchObject({
      package: '@opencode/cli',
      status: 'candidate',
    });
    expect(nativeOpenCodeCandidate.version).toBe(sdk.packages['@opencode/client']);
    expect(nativeOpenCodeCandidate.version).toBe(sdk.packages['@opencode/plugin']);
    const workflow = readFileSync(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    expect(
      workflow.match(/require\('\.\/\.sdk-baselines\/opencode\/cli-candidate\.json'\)/g),
    ).toHaveLength(4);
    expect(workflow).not.toContain('opencode-ai@');
  });

  it('requires an explicit binary to report the exact native version', () => {
    vi.stubEnv('OPENCODE_CLI', '/probe/native-opencode');
    versionProbe(`${host.version}\n`);
    expect(resolvePinnedOpenCodeHost()).toEqual({ ...host, command: '/probe/native-opencode' });
    expect(spawnSync).toHaveBeenCalledWith(
      '/probe/native-opencode',
      ['--version'],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it.each(['1.19.5', nativeOpenCodeCandidate.version, 'opencode v0.0.0', ''])(
    'fails closed on explicit version mismatch %j',
    (actual) => {
      vi.stubEnv('OPENCODE_CLI', '/probe/wrong-opencode');
      versionProbe(actual);
      expect(() => resolvePinnedOpenCodeHost()).toThrow(
        expect.objectContaining({ code: 'OPENCODE_HOST_VERSION_MISMATCH' }),
      );
      expect(spawnSync).toHaveBeenCalledTimes(1);
    },
  );

  it('does not fall back when an explicit binary fails', () => {
    vi.stubEnv('OPENCODE_CLI', '/probe/broken-opencode');
    versionProbe(host.version, 1);
    expect(() => resolvePinnedOpenCodeHost()).toThrow(
      expect.objectContaining({ code: 'OPENCODE_HOST_VERSION_MISMATCH' }),
    );
  });

  it('uses an exact installed native binary', () => {
    vi.stubEnv('OPENCODE_CLI', '');
    versionProbe(host.version);
    expect(resolvePinnedOpenCodeHost()).toEqual(host);
  });

  it('uses the exact native package and disjoint caches when the installed binary differs', () => {
    vi.stubEnv('OPENCODE_CLI', '');
    versionProbe('1.19.5');
    const first = resolvePinnedOpenCodeHost();
    const second = resolvePinnedOpenCodeHost();
    try {
      expect(first.command).toBe('npm');
      expect(first.argsPrefix).toEqual([
        'exec',
        '--yes',
        `--package=@opencode/cli@${nativeOpenCodeCandidate.version}`,
        '--',
        'opencode',
      ]);
      expect(first.env.npm_config_cache).not.toBe(second.env.npm_config_cache);
      expect(existsSync(first.env.npm_config_cache!)).toBe(true);
    } finally {
      rmSync(first.env.npm_config_cache!, { recursive: true, force: true });
      rmSync(second.env.npm_config_cache!, { recursive: true, force: true });
    }
  });
});

describe('createIsolatedOpenCodeEnvironment', () => {
  it('gives parallel host probes disjoint mutable global paths', () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'fg-opencode-first-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'fg-opencode-second-'));
    try {
      const first = createIsolatedOpenCodeEnvironment(firstRoot, host);
      const second = createIsolatedOpenCodeEnvironment(secondRoot, host);
      const isolatedKeys = [
        'HOME',
        'USERPROFILE',
        'OPENCODE_CONFIG_DIR',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_CACHE_HOME',
        'XDG_STATE_HOME',
        'TMPDIR',
        'TMP',
        'TEMP',
      ] as const;

      for (const key of isolatedKeys) expect(first[key]).not.toBe(second[key]);
      expect(first.OPENCODE_CONFIG_DIR).toBe(join(firstRoot, '.config', 'opencode'));
      expect(first.XDG_CONFIG_HOME).toBe(join(firstRoot, '.config'));
      expect(first.XDG_DATA_HOME).toBe(join(firstRoot, '.local', 'share'));
      expect(first.XDG_CACHE_HOME).toBe(join(firstRoot, '.cache'));
      expect(first.XDG_STATE_HOME).toBe(join(firstRoot, '.local', 'state'));
      expect(first.TMPDIR).toBe(firstRoot);
      expect(first.TMP).toBe(first.TMPDIR);
      expect(first.TEMP).toBe(first.TMPDIR);
      expect(
        JSON.parse(readFileSync(join(first.OPENCODE_CONFIG_DIR!, 'opencode.json'), 'utf8')),
      ).toEqual({ update: 'disable' });
      expect(existsSync(first.OPENCODE_CONFIG_DIR!)).toBe(true);
      expect(existsSync(first.TMPDIR!)).toBe(true);
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });
});
