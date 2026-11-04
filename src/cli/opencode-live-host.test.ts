/**
 * @module cli/opencode-live-host.test
 * @description Unit coverage for the private filesystem boundary of real-host smoke probes.
 *
 * @test-policy HAPPY, CORNER — parallel hosts must not share mutable OpenCode paths.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { createPackedFlowGuardInstall } from './opencode-packed-install-test-helpers.js';

const host: PinnedOpenCodeHost = {
  command: 'opencode',
  argsPrefix: [],
  version: `opencode v${nativeOpenCodeCandidate.version}`,
  env: {},
};

vi.mock('node:child_process', () => ({ spawnSync: vi.fn(), execFileSync: vi.fn() }));
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
    const workflows = ['ci.yml', 'opencode-parity.yml']
      .map((file) =>
        readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'),
      )
      .join('\n');
    expect(
      workflows.match(/require\('\.\/\.sdk-baselines\/opencode\/cli-candidate\.json'\)/g),
    ).toHaveLength(8);
    expect(workflows).not.toContain('opencode-ai@');
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

describe('packed bootstrap diagnostics', () => {
  const fixtures: string[] = [];
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
  });
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'fg-packed-diagnostics-test-'));
    fixtures.push(root);
    const tarball = join(root, 'fixture.tgz');
    writeFileSync(tarball, 'exact supplied artifact bytes');
    writeFileSync(join(root, 'checksums.sha256'), 'supplied checksum\n');
    vi.stubEnv('npm_execpath', '/fixture/npm-cli.js');
    vi.stubEnv('FLOWGUARD_TARBALL', tarball);
    vi.stubEnv('FLOWGUARD_BOOTSTRAP_DIAGNOSTICS_DIR', join(root, 'diagnostics'));
    vi.stubEnv('npm_config_cache', '/fixture/shared-cache');
    return {
      root,
      prefix: join(root, 'shared-bootstrap'),
      events() {
        return readdirSync(join(root, 'diagnostics')).map((dir) => {
          const directory = join(root, 'diagnostics', dir);
          const phases = readFileSync(join(directory, 'phases.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          return { directory, phases };
        });
      },
    };
  }
  function npmResult(status: number | null, error?: NodeJS.ErrnoException) {
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      const argv = args as string[];
      const bootstrap = argv[argv.indexOf('--prefix') + 1]!;
      const packedRoot = join(bootstrap, 'node_modules/@flowguard/core/dist');
      mkdirSync(packedRoot, { recursive: true });
      writeFileSync(
        join(packedRoot, 'build-info.json'),
        JSON.stringify({ gitSha: 'fixture-build' }),
      );
      const logs = argv.find((arg) => arg.startsWith('--logs-dir='))!.slice('--logs-dir='.length);
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, 'fixture-debug.log'), 'npm debug before exit\n');
      return {
        pid: 12345,
        status,
        signal: error ? 'SIGTERM' : null,
        error,
        stdout: 'npm stdout before exit\n',
        stderr: 'npm stderr before exit\n',
      } as ReturnType<typeof spawnSync>;
    });
  }
  it('records phases, package digest and npm PID while preserving shared cache and budgets', async () => {
    const probe = fixture();
    npmResult(0);
    const artifact = await createPackedFlowGuardInstall();
    try {
      const { directory, phases } = probe.events()[0]!;
      expect(phases.map((event) => event.stage)).toEqual([
        'tarball-begin',
        'tarball-ready',
        'npm-install-begin',
        'npm-install-end',
        'identity-ready',
      ]);
      expect(phases[1].sha256).toBe(artifact.identity.sha256);
      expect(phases[2]).toMatchObject({
        timeoutMs: 300_000,
        configuredCache: '/fixture/shared-cache',
      });
      expect(phases[3]).toMatchObject({
        workerPID: process.pid,
        npmPID: 12345,
        status: 0,
        signal: null,
        error: null,
      });
      expect(phases[3].elapsedMs).toBeGreaterThanOrEqual(phases[2].elapsedMs);
      expect(spawnSync).toHaveBeenCalledWith(
        process.execPath,
        [
          '/fixture/npm-cli.js',
          'install',
          '--prefix',
          expect.any(String),
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--loglevel=verbose',
          `--logs-dir=${join(directory, 'npm-debug')}`,
          expect.any(String),
        ],
        expect.objectContaining({
          timeout: 300_000,
          encoding: 'utf8',
        }),
      );
      expect(vi.mocked(spawnSync).mock.calls[0]![2]).not.toHaveProperty('env');
      expect(vi.mocked(spawnSync).mock.calls[0]![2]).not.toHaveProperty('stdio');
    } finally {
      await artifact.close();
    }
    expect(existsSync(probe.events()[0]!.directory)).toBe(true);
  });
  it.each(['timeout', 'exit'] as const)(
    'retains npm logs and explicitly fails on %s',
    async (kind) => {
      const probe = fixture();
      const error = Object.assign(new Error('spawnSync timed out'), { code: 'ETIMEDOUT' });
      npmResult(kind === 'timeout' ? null : 1, kind === 'timeout' ? error : undefined);
      await expect(createPackedFlowGuardInstall()).rejects.toMatchObject(
        kind === 'timeout' ? { code: 'ETIMEDOUT' } : { status: 1, signal: null },
      );
      const { directory, phases } = probe.events()[0]!;
      expect(phases.at(-1)).toMatchObject({
        stage: 'bootstrap-failed',
        failedStage: 'npm-install',
      });
      expect(phases.at(-2)).toMatchObject({
        stage: 'npm-install-end',
        npmPID: 12345,
        status: kind === 'timeout' ? null : 1,
      });
      if (kind === 'timeout') expect(phases.at(-2).error.code).toBe('ETIMEDOUT');
      expect(readFileSync(join(directory, 'npm.stdout.log'), 'utf8')).toContain(
        'npm stdout before exit',
      );
      expect(readFileSync(join(directory, 'npm.stderr.log'), 'utf8')).toContain(
        'npm stderr before exit',
      );
      expect(readFileSync(join(directory, 'npm-debug/fixture-debug.log'), 'utf8')).toContain(
        'npm debug before exit',
      );
      expect(existsSync(phases[0].root)).toBe(false);
    },
  );
  it('reuses one digest-bound bootstrap and records the reuse instead of npm', async () => {
    const probe = fixture();
    vi.stubEnv('FLOWGUARD_BOOTSTRAP_PREFIX', probe.prefix);
    npmResult(0);
    const first = await createPackedFlowGuardInstall();
    await first.close();
    const second = await createPackedFlowGuardInstall();
    try {
      expect(spawnSync).toHaveBeenCalledTimes(1);
      expect(second.identity).toEqual(first.identity);
      expect(existsSync(join(probe.prefix, 'bootstrap-identity.json'))).toBe(true);
      const reusedRun = probe
        .events()
        .find((event) => event.phases.some((phase) => phase.stage === 'bootstrap-reused'));
      expect(reusedRun?.phases.map((event) => event.stage)).toEqual([
        'tarball-begin',
        'tarball-ready',
        'bootstrap-reused',
        'identity-ready',
      ]);
      expect(reusedRun?.phases[2].bootstrap).toBe(probe.prefix);
    } finally {
      await second.close();
    }
  });
  it('reinstalls when the shared prefix belongs to a different artifact digest', async () => {
    const probe = fixture();
    vi.stubEnv('FLOWGUARD_BOOTSTRAP_PREFIX', probe.prefix);
    npmResult(0);
    const first = await createPackedFlowGuardInstall();
    await first.close();
    writeFileSync(join(probe.root, 'fixture.tgz'), 'different artifact bytes');
    const second = await createPackedFlowGuardInstall();
    try {
      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(second.identity.sha256).not.toBe(first.identity.sha256);
      expect(
        probe
          .events()
          .filter((event) => event.phases.some((phase) => phase.stage === 'npm-install-begin')),
      ).toHaveLength(2);
    } finally {
      await second.close();
    }
  });
  it('keeps concurrent bootstrap diagnostics disjoint without reusing the installation', async () => {
    const probe = fixture();
    npmResult(0);
    const artifacts = await Promise.all([
      createPackedFlowGuardInstall(),
      createPackedFlowGuardInstall(),
    ]);
    try {
      const records = probe.events();
      expect(records).toHaveLength(2);
      expect(records[0]!.directory).not.toBe(records[1]!.directory);
      expect(records[0]!.phases[0].root).not.toBe(records[1]!.phases[0].root);
      expect(artifacts[0].identity).toEqual(artifacts[1].identity);
      expect(spawnSync).toHaveBeenCalledTimes(2);
    } finally {
      await Promise.all(artifacts.map((artifact) => artifact.close()));
    }
  });
});
