/**
 * @module cli/opencode-live-host-test-helpers
 * @description Shared resolver for the pinned OpenCode host used by live smoke
 * tests (reviewer wire contract).
 *
 * Resolution order:
 * 1. `OPENCODE_CLI` — explicit binary/command.
 * 2. An installed `opencode` binary whose `--version` EXACTLY matches the pinned
 *    `.sdk-baselines/opencode/cli-candidate.json` (the CI smoke job installs the
 *    pinned host globally).
 * 3. `npm exec --package=@opencode/cli@<version> -- opencode` with a PER-CALL
 *    isolated npm cache. Concurrent smoke files must never share an npx cache:
 *    parallel installs of the same tarball corrupt the shared cache tree.
 *
 * @internal — smoke-test support module
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Test target only, deliberately independent of historical support evidence. */
type NativeHostPinCode = 'OPENCODE_CANDIDATE_INVALID' | 'OPENCODE_HOST_VERSION_MISMATCH';
class NativeHostPinError extends Error {
  constructor(
    readonly code: NativeHostPinCode,
    message: string,
  ) {
    super(message);
  }
}

export const nativeOpenCodeCandidate = JSON.parse(
  readFileSync(
    new URL('../../.sdk-baselines/opencode/cli-candidate.json', import.meta.url),
    'utf8',
  ),
) as { readonly package: string; readonly version: string; readonly status: string };
if (
  nativeOpenCodeCandidate.package !== '@opencode/cli' ||
  nativeOpenCodeCandidate.status !== 'candidate' ||
  !/^\d+\.\d+\.\d+$/.test(nativeOpenCodeCandidate.version)
) {
  throw new NativeHostPinError(
    'OPENCODE_CANDIDATE_INVALID',
    'Invalid native OpenCode CLI candidate pin',
  );
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
  writeFileSync(join(configDir, 'opencode.json'), '{"update":"disable"}\n');
  return {
    ...process.env,
    ...host.env,
    HOME: root,
    USERPROFILE: root,
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

function reportedVersion(command: string): string | null {
  const probe = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: process.env,
  });
  return probe.status === 0 ? (probe.stdout ?? '').trim() : null;
}

/** Resolve the pinned host command for a live smoke test. */
export function resolvePinnedOpenCodeHost(): PinnedOpenCodeHost {
  const baseline = nativeOpenCodeCandidate;
  const version = `opencode v${baseline.version}`;
  const explicit = process.env.OPENCODE_CLI;
  if (explicit !== undefined && explicit.length > 0) {
    const actual = reportedVersion(explicit);
    if (actual !== version) {
      throw new NativeHostPinError(
        'OPENCODE_HOST_VERSION_MISMATCH',
        `Expected ${version}; OPENCODE_CLI reported ${actual ?? 'no successful version'}`,
      );
    }
    return {
      command: explicit,
      argsPrefix: [],
      version,
      env: {},
    };
  }

  if (reportedVersion('opencode') === version) {
    return {
      command: 'opencode',
      argsPrefix: [],
      version,
      env: {},
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
    version,
    env: { npm_config_cache: cacheDir },
  };
}
