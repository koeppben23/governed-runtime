/**
 * @module cli/install-verify.smoke.test
 * @description Smoke tests for release tarball verification.
 *
 * Run with: npm run test:install-verify
 *
 * These tests verify the release tarball can be distributed and used.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = (await fs.readFile(path.join(REPO_ROOT, 'VERSION'), 'utf-8')).trim();
const NPM_CLI = process.env.npm_execpath;

let tmpDir: string;
let tarballPath: string;
let installedDir: string;
let omitOptionalDir: string;
let packedPackageJson: {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
let packedFiles: string[];

const providedTarball = process.env.FLOWGUARD_TARBALL;

/**
 * Opt-in npm timing diagnostics: `--timing` plus a bounded aggregation of the
 * install's timing file (no raw npm logs). Kept off by default so the smoke
 * path stays lean.
 */
const NPM_TIMING_ENABLED = process.env.FLOWGUARD_SMOKE_NPM_TIMING === '1';

async function createTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'gov-smoke-'));
}

async function cleanTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

async function runFile(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; code: number; failure?: string }> {
  return await new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout: stdout || '', stderr: stderr || '', code: 0 });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : 1;
        resolve({
          stdout: stdout || error.message || '',
          stderr: stderr || '',
          code,
          failure: `${error.message.split('\n')[0]}\nProcess code: ${String(error.code)}; signal: ${String(error.signal)}; killed: ${String(error.killed)}`,
        });
      },
    );
  });
}

function commandForLog(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

function npmArgs(args: readonly string[]): string[] {
  if (!NPM_CLI) {
    throw new Error('npm_execpath is required to run install verification tests');
  }
  return [NPM_CLI, ...args];
}

function assertSuccess(
  result: { stdout: string; stderr: string; code: number; failure?: string },
  command: string,
): void {
  if (result.code === 0) {
    return;
  }

  const stdout = result.stdout.slice(0, 4000);
  const stderr = result.stderr.slice(0, 4000);
  throw new Error(
    `Command failed: ${command}\nExit code: ${result.code}\n${result.failure ?? ''}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  );
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Wall-clock timing line for one smoke step (bounded, one line per step). */
async function timedStep<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  try {
    const value = await fn();
    console.log(
      `[install-verify][timing] ${label} ${formatSeconds(performance.now() - started)} ok`,
    );
    return value;
  } catch (error) {
    console.error(
      `[install-verify][timing] ${label} ${formatSeconds(performance.now() - started)} failed`,
    );
    throw error;
  }
}

/** npm's own one-line install summary, when present (never raw output). */
function npmSummary(stdout: string): string | null {
  const match = /added \d+ packages? in [\d.]+s/.exec(stdout);
  return match ? match[0] : null;
}

let resolvedNpmCacheDir: string | null | undefined;

/** Resolve the npm cache directory the way npm itself does. */
function npmCacheDir(): string | null {
  if (resolvedNpmCacheDir !== undefined) return resolvedNpmCacheDir;
  const fromEnv = process.env.npm_config_cache;
  if (fromEnv && fromEnv.length > 0) {
    resolvedNpmCacheDir = fromEnv;
    return resolvedNpmCacheDir;
  }
  try {
    const out = execFileSync(process.execPath, npmArgs(['config', 'get', 'cache']), {
      encoding: 'utf-8',
    }).trim();
    resolvedNpmCacheDir = out.length > 0 ? out : null;
  } catch {
    resolvedNpmCacheDir = null;
  }
  return resolvedNpmCacheDir;
}

async function npmTimingFiles(cacheDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(cacheDir, '_logs'));
    return entries.filter((name) => name.endsWith('-timing.json'));
  } catch {
    return [];
  }
}

function boundedMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Bounded aggregation of one npm timing file. Phase totals are taken from
 * their exact aggregate keys (prefix sums would double-count the nested
 * per-package timers); `fetch` sums only real `http*` timers, so a warm cache
 * honestly reports 0. Raw keys are length-capped; raw npm logs are never read
 * or printed.
 */
const TIMING_AGGREGATE_KEYS = new Set(['npm', 'command:install', 'reify', 'idealTree']);
const TIMING_PER_PACKAGE_PREFIXES = ['reifyNode:', 'idealTree:node_modules/', 'idealTree:#root'];

function summarizeNpmTiming(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const timers = (parsed as { timers?: unknown }).timers;
  if (!timers || typeof timers !== 'object') return null;
  const entries = Object.entries(timers as Record<string, unknown>)
    .map(([name, value]) => [name, boundedMs(value)] as const)
    .filter((entry): entry is readonly [string, number] => entry[1] !== null);
  if (entries.length === 0) return null;

  const byName = new Map(entries);
  const total = byName.get('command:install') ?? byName.get('npm') ?? null;
  const idealTreeMs = byName.get('idealTree') ?? null;
  const reifyMs = byName.get('reify') ?? null;
  const fetchMs = entries
    .filter(([name]) => name.startsWith('http'))
    .reduce((sum, [, ms]) => sum + ms, 0);
  const top = [...entries]
    .filter(
      ([name]) =>
        !TIMING_AGGREGATE_KEYS.has(name) &&
        !TIMING_PER_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix)),
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, ms]) => `${name.slice(0, 48)}=${ms}ms`)
    .join(',');

  return [
    ...(total !== null ? [`total=${total}ms`] : []),
    ...(idealTreeMs !== null ? [`idealTree=${idealTreeMs}ms`] : []),
    ...(reifyMs !== null ? [`reify=${reifyMs}ms`] : []),
    `fetch=${fetchMs}ms`,
    ...(top.length > 0 ? [`top3=${top}`] : []),
  ].join(' ');
}

/** Read exactly the timing file written by the install that just finished. */
async function readNewNpmTimingSummary(
  cacheDir: string | null,
  knownFiles: readonly string[],
): Promise<string | null> {
  if (cacheDir === null) return null;
  const known = new Set(knownFiles);
  const fresh = (await npmTimingFiles(cacheDir)).filter((name) => !known.has(name));
  if (fresh.length !== 1) return null;
  try {
    const raw = await fs.readFile(path.join(cacheDir, '_logs', fresh[0]!), 'utf-8');
    if (raw.length > 256 * 1024) return null;
    return summarizeNpmTiming(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function parseTarEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const rawPrefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const name = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
    const sizeText = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    entries.set(name, buffer.subarray(dataStart, dataEnd));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function readPackedTarball(): Promise<{
  packageJson: {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  files: string[];
}> {
  const tarball = gunzipSync(await fs.readFile(tarballPath));
  const entries = parseTarEntries(tarball);
  const packageJson = entries.get('package/package.json');
  if (!packageJson) {
    throw new Error('Packed tarball is missing package/package.json');
  }

  return {
    packageJson: JSON.parse(packageJson.toString('utf8')),
    files: [...entries.keys()],
  };
}

async function writeFreshPackageProject(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
}

async function installTarball(
  cwd: string,
  extraArgs: readonly string[] = [],
  timeoutMs = 420_000,
): Promise<void> {
  const cacheDir = NPM_TIMING_ENABLED ? npmCacheDir() : null;
  const knownTimingFiles = cacheDir !== null ? await npmTimingFiles(cacheDir) : [];
  const installArgs = [
    'install',
    '--prefer-offline',
    ...(NPM_TIMING_ENABLED ? ['--timing'] : []),
    ...extraArgs,
    '--no-audit',
    '--no-fund',
    tarballPath,
  ];
  const installRes = await runFile(process.execPath, npmArgs(installArgs), cwd, timeoutMs);
  assertSuccess(installRes, commandForLog('npm', installArgs));
  const summary = npmSummary(installRes.stdout);
  if (summary !== null) {
    console.log(`[install-verify][npm] ${summary}`);
  }
  if (NPM_TIMING_ENABLED) {
    const timingSummary = await readNewNpmTimingSummary(cacheDir, knownTimingFiles);
    console.log(
      timingSummary !== null
        ? `[install-verify][npm-timing] ${timingSummary}`
        : '[install-verify][npm-timing] unavailable for this install',
    );
  }
}

describe('install-verify', () => {
  beforeAll(async () => {
    tmpDir = await createTmpDir();
    if (providedTarball) {
      // Use existing tarball (for Release workflow smoke test)
      tarballPath = path.resolve(providedTarball);
    } else {
      // Pack new tarball (default behavior)
      await timedStep('npm pack', () => {
        tarballPath = path.join(tmpDir, `flowguard-core-${VERSION}.tgz`);
        execFileSync(process.execPath, npmArgs(['pack', '--pack-destination', tmpDir]), {
          cwd: REPO_ROOT,
          encoding: 'utf-8',
        });
      });
    }
    const tarball = await readPackedTarball();
    packedPackageJson = tarball.packageJson;
    packedFiles = tarball.files;

    // One full-dependency install plus ONE shared `--omit=optional` install.
    // The omit fixture serves both omit assertions; no second omit install is
    // performed, and no test is dropped. Measured on Windows: running the two
    // installs concurrently is slower (npm cache and disk I/O contention,
    // 312/220/218 s parallel vs 213 s sequential), so they stay sequential.
    installedDir = path.join(tmpDir, 'installed');
    omitOptionalDir = path.join(tmpDir, 'omit-optional');
    await writeFreshPackageProject(installedDir);
    await writeFreshPackageProject(omitOptionalDir);

    await timedStep('install(regular)', () => installTarball(installedDir));
    await timedStep('install(omit=optional)', () =>
      installTarball(omitOptionalDir, ['--omit=optional'], 480_000),
    );
  }, 900_000);

  afterAll(async () => {
    await timedStep('cleanup(rm)', () => cleanTmpDir(tmpDir));
  }, 180_000);

  describe('Tarball', () => {
    it('package.json has @opentelemetry/api in dependencies', async () => {
      expect(packedPackageJson.dependencies?.['@opentelemetry/api']).toBeDefined();
      expect(packedPackageJson.dependencies?.['@opentelemetry/api']).toMatch(/^\^1\./);
    });

    it('package.json has OTEL SDK packages in optionalDependencies', async () => {
      expect(packedPackageJson.optionalDependencies).toBeDefined();
      expect(packedPackageJson.optionalDependencies?.['@opentelemetry/sdk-node']).toBeDefined();
      expect(
        packedPackageJson.optionalDependencies?.['@opentelemetry/exporter-trace-otlp-http'],
      ).toBeDefined();
      expect(
        packedPackageJson.optionalDependencies?.['@opentelemetry/auto-instrumentations-node'],
      ).toBeDefined();
    });

    it('installs with --omit=optional without crashing', () => {
      const packageDir = path.join(omitOptionalDir, 'node_modules', '@flowguard', 'core');
      expect(existsSync(path.join(packageDir, 'dist', 'index.js'))).toBe(true);
    }, 30_000);

    it('imports core module with --omit=optional', async () => {
      const res = await runFile(
        'node',
        [
          '-e',
          "import('@flowguard/core').then(m => console.log('ok')).catch(e => { console.error(e.message); process.exit(1); })",
        ],
        omitOptionalDir,
      );
      expect(res.code).toBe(0);
    }, 60_000);

    it('tarball is installed in shared node_modules', () => {
      expect(existsSync(path.join(installedDir, 'node_modules', '@flowguard', 'core'))).toBe(true);
    });

    it('can import @flowguard/core after install', async () => {
      const res = await runFile(
        'node',
        [
          '-e',
          "import('@flowguard/core').then(() => console.log('ok')).catch(e => { console.error(e.message); process.exit(1); })",
        ],
        installedDir,
      );
      expect(res.code).toBe(0);
    }, 30_000);

    it('@flowguard/core/testing exports createTestContext', async () => {
      const res = await runFile(
        'node',
        [
          '--input-type=module',
          '-e',
          "import('@flowguard/core/testing').then(m => { if (typeof m.createTestContext !== 'function') { console.error('createTestContext not found'); process.exit(1); } console.log('ok'); }).catch(e => { console.error(e.message); process.exit(1); })",
        ],
        installedDir,
      );
      expect(res.code).toBe(0);
    }, 30_000);

    it('@flowguard/core excludes integration and testing exports', async () => {
      const res = await runFile(
        'node',
        [
          '--input-type=module',
          '-e',
          "import('@flowguard/core').then(m => { if (typeof m.createTestContext !== 'undefined') { console.error('createTestContext leaked'); process.exit(1); } if (typeof m.plan !== 'undefined') { console.error('plan leaked'); process.exit(1); } if (typeof m.FlowGuardAuditPlugin !== 'undefined') { console.error('FlowGuardAuditPlugin leaked'); process.exit(1); } if (typeof m.resolvePolicy !== 'undefined') { console.error('resolvePolicy leaked'); process.exit(1); } if (typeof m.getPolicyPreset !== 'function') { console.error('getPolicyPreset missing'); process.exit(1); } console.log('ok'); }).catch(e => { console.error(e.message); process.exit(1); })",
        ],
        installedDir,
      );
      expect(res.code).toBe(0);
    }, 30_000);

    it('has expected files in tarball', async () => {
      const distFiles = packedFiles.filter((file) => file.startsWith('package/dist/'));
      expect(distFiles.length).toBeGreaterThan(10);
      // The public testing entry stays production.
      expect(distFiles).toContain('package/dist/testing.js');
      expect(distFiles).toContain('package/dist/testing.d.ts');
    });

    it('never ships internal test support in the tarball', async () => {
      const scaffolding = packedFiles.filter((file) => {
        if (!file.startsWith('package/dist/')) return false;
        const rel = file.slice('package/dist/'.length);
        return (
          /(^|\/)(test-helpers|evidence-test-constants)\.(js|d\.ts|js\.map)$/.test(rel) ||
          /-test-helpers\.(js|d\.ts|js\.map)$/.test(rel) ||
          /-test-fixtures\.(js|d\.ts|js\.map)$/.test(rel) ||
          /^fixtures\./.test(rel) ||
          /^test-policy\./.test(rel) ||
          rel.startsWith('audit/__fixtures__/') ||
          rel.startsWith('architecture/') ||
          rel.startsWith('documentation/') ||
          rel.startsWith('security/')
        );
      });
      expect(scaffolding, scaffolding.join('\n')).toEqual([]);
    });

    it('checksums.sha256 matches tarball (integrity smoke)', async () => {
      const { verifyTarballChecksum } = await import('./install-helpers-integrity.js');
      const { hashFile } = await import('../shared/hashing.js');
      const checksumsPath = path.join(tmpDir, 'checksums.sha256');
      const tarballName = path.basename(tarballPath);
      const sha256 = await hashFile(tarballPath);
      await fs.writeFile(checksumsPath, `${sha256}  ${tarballName}\n`);
      await expect(verifyTarballChecksum(tarballPath, checksumsPath)).resolves.toBeUndefined();
    });
  });
});
