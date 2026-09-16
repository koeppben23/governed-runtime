/**
 * @module cli/opencode-live-host
 * @description Shared resolver for the pinned OpenCode host used by live smoke
 * tests (reviewer wire contract, mandate visibility, host boundary).
 *
 * Resolution order:
 * 1. `OPENCODE_CLI` — explicit binary/command.
 * 2. An installed `opencode` binary whose `--version` EXACTLY matches the pinned
 *    `.sdk-baselines/opencode/host-version.json` (the CI smoke job installs the
 *    pinned host globally).
 * 3. `npm exec --package=opencode-ai@<version> -- opencode` with a PER-CALL
 *    isolated npm cache. Concurrent smoke files must never share an npx cache:
 *    parallel installs of the same tarball corrupt the shared cache tree.
 *
 * @internal — smoke-test support module
 */

import { mkdtempSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface OpenCodeHostBaseline {
  readonly package: string;
  readonly version: string;
}

export interface PinnedOpenCodeHost {
  readonly command: string;
  readonly argsPrefix: readonly string[];
  readonly version: string;
  /** Environment additions required to run this host safely. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Give each real-host smoke process its own OpenCode global directories.
 * OpenCode uses XDG paths and `os.tmpdir()` for mutable state, so sharing the
 * parent process values lets parallel probes interfere with one another.
 */
export function createIsolatedOpenCodeEnvironment(
  root: string,
  host: PinnedOpenCodeHost,
): NodeJS.ProcessEnv {
  const configDir = join(root, '.config', 'opencode');
  mkdirSync(configDir, { recursive: true });
  return {
    ...process.env,
    ...host.env,
    HOME: root,
    USERPROFILE: root,
    OPENCODE_TEST_HOME: root,
    OPENCODE_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_DATA_HOME: join(root, '.local', 'share'),
    XDG_CACHE_HOME: join(root, '.cache'),
    XDG_STATE_HOME: join(root, '.local', 'state'),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
  };
}

function installedVersionMatches(version: string): boolean {
  const probe = spawnSync('opencode', ['--version'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' },
  });
  return probe.status === 0 && (probe.stdout ?? '').trim() === version;
}

/** Resolve the pinned host command for a live smoke test. */
export function resolvePinnedOpenCodeHost(baseline: OpenCodeHostBaseline): PinnedOpenCodeHost {
  const explicit = process.env.OPENCODE_CLI;
  if (explicit !== undefined && explicit.length > 0) {
    return {
      command: explicit,
      argsPrefix: [],
      version: baseline.version,
      env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
    };
  }

  if (installedVersionMatches(baseline.version)) {
    return {
      command: 'opencode',
      argsPrefix: [],
      version: baseline.version,
      env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
    };
  }

  // Per-call isolated cache: two smoke files running concurrently must not
  // install the same package into one npx cache.
  const cacheDir = mkdtempSync(join(tmpdir(), 'fg-opencode-npx-'));
  mkdirSync(cacheDir, { recursive: true });
  return {
    command: 'npm',
    argsPrefix: [
      'exec',
      '--yes',
      `--package=${baseline.package}@${baseline.version}`,
      '--',
      'opencode',
    ],
    version: baseline.version,
    env: { OPENCODE_DISABLE_AUTOUPDATE: '1', npm_config_cache: cacheDir },
  };
}
