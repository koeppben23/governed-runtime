/**
 * @module cli/install-verify.test
 * @description Smoke tests for release tarball verification.
 *
 * Run with: npm run test:install-verify
 *
 * These tests verify the release tarball can be distributed and used.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = (await fs.readFile(path.join(REPO_ROOT, 'VERSION'), 'utf-8')).trim();
const NPM_CLI = process.env.npm_execpath;

let tmpDir: string;
let tarballPath: string;
let installedDir: string;
let packedPackageJson: {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
let packedFiles: string[];

const providedTarball = process.env.FLOWGUARD_TARBALL;

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

function runFile(
  command: string,
  args: readonly string[],
  cwd: string,
): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 420000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout || '', stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
    const stdout = e.stdout || e.message || '';
    const stderr = e.stderr || '';
    const code = typeof e.status === 'number' ? e.status : 1;
    return { stdout, stderr, code };
  }
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
  result: { stdout: string; stderr: string; code: number },
  command: string,
): void {
  if (result.code === 0) {
    return;
  }

  const stdout = result.stdout.slice(0, 4000);
  const stderr = result.stderr.slice(0, 4000);
  throw new Error(
    `Command failed: ${command}\nExit code: ${result.code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  );
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

describe('install-verify', () => {
  beforeAll(async () => {
    tmpDir = await createTmpDir();
    if (providedTarball) {
      // Use existing tarball (for Release workflow smoke test)
      tarballPath = path.resolve(providedTarball);
    } else {
      // Pack new tarball (default behavior)
      tarballPath = path.join(tmpDir, `flowguard-core-${VERSION}.tgz`);
      execFileSync(process.execPath, npmArgs(['pack', '--pack-destination', tmpDir]), {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
    }
    const tarball = await readPackedTarball();
    packedPackageJson = tarball.packageJson;
    packedFiles = tarball.files;

    installedDir = path.join(tmpDir, 'installed');
    await fs.mkdir(installedDir, { recursive: true });
    await fs.writeFile(
      path.join(installedDir, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );
    const installArgs = ['install', '--prefer-offline', '--no-audit', '--no-fund', tarballPath];
    const installRes = runFile(process.execPath, npmArgs(installArgs), installedDir);
    assertSuccess(installRes, commandForLog('npm', installArgs));
  }, 480_000);

  afterAll(async () => {
    await cleanTmpDir(tmpDir);
  }, 120000);

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

    it('installs with --omit=optional without crashing', async () => {
      const p = path.join(tmpDir, 'omit-optional-test');
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(
        path.join(p, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );
      const args = [
        'install',
        '--prefer-offline',
        '--omit=optional',
        '--no-audit',
        '--no-fund',
        tarballPath,
      ];
      const res = runFile(process.execPath, npmArgs(args), p);
      assertSuccess(res, commandForLog('npm', args));
    }, 240000);

    it('imports core module with --omit=optional', async () => {
      const p = path.join(tmpDir, 'omit-optional-import-test');
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(
        path.join(p, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );
      const installArgs = [
        'install',
        '--prefer-offline',
        '--omit=optional',
        '--no-audit',
        '--no-fund',
        tarballPath,
      ];
      const install = runFile(process.execPath, npmArgs(installArgs), p);
      assertSuccess(install, commandForLog('npm', installArgs));
      const res = runFile(
        'node',
        [
          '-e',
          "import('@flowguard/core').then(m => console.log('ok')).catch(e => { console.error(e.message); process.exit(1); })",
        ],
        p,
      );
      expect(res.code).toBe(0);
    }, 240000);

    it('tarball is installed in shared node_modules', () => {
      expect(fs.existsSync(path.join(installedDir, 'node_modules', '@flowguard', 'core'))).toBe(
        true,
      );
    });

    it('can import @flowguard/core after install', async () => {
      const res = runFile(
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
      const res = runFile(
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
      const res = runFile(
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
    });

    it('checksums.sha256 matches tarball (integrity smoke)', async () => {
      const { verifyTarballChecksum } = await import('./install-helpers.js');
      const { hashFile } = await import('../shared/hashing.js');
      const checksumsPath = path.join(tmpDir, 'checksums.sha256');
      const tarballName = path.basename(tarballPath);
      const sha256 = await hashFile(tarballPath);
      await fs.writeFile(checksumsPath, `${sha256}  ${tarballName}\n`);
      await expect(verifyTarballChecksum(tarballPath, checksumsPath)).resolves.toBeUndefined();
    });
  });
});
