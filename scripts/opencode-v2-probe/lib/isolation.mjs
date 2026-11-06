import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export class ProbeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ProbeError';
    this.code = code;
  }
}

/** Explicit test environment, not an OS sandbox or an operator-auth boundary. */
export function probeEnvironment(root) {
  return {
    PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    TMPDIR: join(root, 'tmp'),
    SHELL: '/bin/sh',
    LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export async function readJournal(path) {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    throw new ProbeError('PROBE_JOURNAL_UNREADABLE', `Invalid/unreadable journal: ${path}`, {
      cause: error,
    });
  }
}

export function assertProbePaths(paths, root) {
  for (const key of ['home', 'config', 'data', 'state', 'cache', 'tmp', 'db']) {
    const path = paths[key];
    if (
      !isAbsolute(path ?? '') ||
      (resolve(path) !== root && !resolve(path).startsWith(`${root}/`))
    ) {
      throw new ProbeError('PROBE_PATH_ESCAPE', `Host ${key} escapes isolated root`);
    }
  }
}

/** Stop only this owned child; never touch the operator's shared service. */
export async function stopProbeProcess(proc, graceMs = 5_000) {
  if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!proc.kill('SIGKILL'))
        reject(new ProbeError('PROBE_CLEANUP_FAILED', 'Cannot stop private server'));
    }, graceMs);
    proc.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

function ancestors(path) {
  const result = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    result.push(current);
    if (dirname(current) === current) return result;
  }
}

export function systemConfigPaths(platform = process.platform, username = userInfo().username) {
  if (platform === 'darwin') {
    return [
      '/Library/Application Support/opencode',
      '/Library/Managed Preferences/ai.opencode.managed.plist',
      `/Library/Managed Preferences/${username}/ai.opencode.managed.plist`,
    ];
  }
  if (platform === 'linux') return ['/etc/opencode'];
  throw new ProbeError('PROBE_PLATFORM_UNVERIFIED', `Isolation not verified on ${platform}`);
}

/** Reject contamination, including dangling links; never ignore access errors. */
export async function assertCleanDiscovery(base, systemPaths = systemConfigPaths()) {
  const directories = new Set([...ancestors(base), ...ancestors(await realpath(base))]);
  const candidates = [
    ...[...directories].flatMap((directory) =>
      ['opencode.json', 'opencode.jsonc', '.opencode', 'AGENTS.md'].map((name) =>
        join(directory, name),
      ),
    ),
    ...systemPaths,
  ];
  for (const path of new Set(candidates)) {
    try {
      await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new ProbeError('PROBE_DISCOVERY_UNREADABLE', `Cannot inspect ${path}`, {
        cause: error,
      });
    }
    throw new ProbeError(
      'PROBE_DISCOVERY_CONTAMINATED',
      `Ambient configuration/instructions: ${path}`,
    );
  }
  return { checkedPaths: [...new Set(candidates)], absent: true };
}

export async function pinHost(binary, cwd, env) {
  const resolved = isAbsolute(binary)
    ? binary
    : execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'probe', binary], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 10_000,
      }).trim();
  const path = await realpath(resolved);
  const version = execFileSync(path, ['--version'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
  if (version !== 'opencode v2.2.4') {
    throw new ProbeError(
      'PROBE_HOST_VERSION_MISMATCH',
      `Expected opencode v2.2.4; received ${version}`,
    );
  }
  const packages = {};
  for (const name of ['client', 'plugin']) {
    const path = new URL(`../node_modules/@opencode/${name}/package.json`, import.meta.url);
    const bytes = await readFile(path);
    const info = JSON.parse(bytes.toString('utf8'));
    if (info.version !== '2.2.4') {
      throw new ProbeError('PROBE_SDK_VERSION_MISMATCH', `${info.name}: ${info.version}`);
    }
    packages[info.name] = { version: info.version, packageJsonSha256: digest(bytes) };
  }
  return { path, version, sha256: digest(await readFile(path)), packages };
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
