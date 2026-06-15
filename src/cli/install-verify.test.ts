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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = (await fs.readFile(path.join(REPO_ROOT, 'VERSION'), 'utf-8')).trim();

let tmpDir: string;
let tarballPath: string;

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

async function installTarballForInspection(prefix: string): Promise<string> {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(
    path.join(p, 'package.json'),
    JSON.stringify({ name: 'test', type: 'module' }),
  );
  const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath];
  assertSuccess(runFile('npm', args, p), commandForLog('npm', args));
  return p;
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
      execFileSync('npm', ['pack', '--pack-destination', tmpDir], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
    }
  });

  afterAll(async () => {
    await cleanTmpDir(tmpDir);
  }, 120000);

  describe('Tarball', () => {
    it('package.json has @opentelemetry/api in dependencies', async () => {
      const tmp = await installTarballForInspection('gov-pkg-');
      try {
        const pkg = JSON.parse(
          await fs.readFile(
            path.join(tmp, 'node_modules', '@flowguard', 'core', 'package.json'),
            'utf-8',
          ),
        );
        expect(pkg.dependencies['@opentelemetry/api']).toBeDefined();
        expect(pkg.dependencies['@opentelemetry/api']).toMatch(/^\^1\./);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it('package.json has OTEL SDK packages in optionalDependencies', async () => {
      const tmp = await installTarballForInspection('gov-pkg-');
      try {
        const pkg = JSON.parse(
          await fs.readFile(
            path.join(tmp, 'node_modules', '@flowguard', 'core', 'package.json'),
            'utf-8',
          ),
        );
        expect(pkg.optionalDependencies).toBeDefined();
        expect(pkg.optionalDependencies['@opentelemetry/sdk-node']).toBeDefined();
        expect(pkg.optionalDependencies['@opentelemetry/exporter-trace-otlp-http']).toBeDefined();
        expect(pkg.optionalDependencies['@opentelemetry/auto-instrumentations-node']).toBeDefined();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it('installs with --omit=optional without crashing', async () => {
      const p = path.join(tmpDir, 'omit-optional-test');
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(
        path.join(p, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );
      const args = ['install', '--omit=optional', '--no-audit', '--no-fund', tarballPath];
      const res = runFile('npm', args, p);
      assertSuccess(res, commandForLog('npm', args));
    }, 240000);

    it('imports core module with --omit=optional', async () => {
      const p = path.join(tmpDir, 'omit-optional-import-test');
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(
        path.join(p, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );
      const installArgs = ['install', '--omit=optional', '--no-audit', '--no-fund', tarballPath];
      const install = runFile('npm', installArgs, p);
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

    it('tarball can be installed in fresh project', async () => {
      const p = path.join(tmpDir, 'install-test');
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(
        path.join(p, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );
      const args = ['install', '--no-audit', '--no-fund', tarballPath];
      const res = runFile('npm', args, p);
      assertSuccess(res, commandForLog('npm', args));
    }, 480000);

    it('can import @flowguard/core after install', async () => {
      const p = path.join(tmpDir, 'import-test');
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(
        path.join(p, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );
      const installArgs = ['install', '--no-audit', '--no-fund', tarballPath];
      const install = runFile('npm', installArgs, p);
      assertSuccess(install, commandForLog('npm', installArgs));
      const res = runFile(
        'node',
        [
          '-e',
          "import('@flowguard/core').then(() => console.log('ok')).catch(e => { console.error(e.message); process.exit(1); })",
        ],
        p,
      );
      expect(res.code).toBe(0);
    }, 240000);

    it('@flowguard/core/testing exports createTestContext', async () => {
      const p = path.join(tmpDir, 'api-smoke-testing');
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(
        path.join(p, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );
      const installArgs = ['install', '--no-audit', '--no-fund', tarballPath];
      assertSuccess(runFile('npm', installArgs, p), commandForLog('npm', installArgs));

      const res = runFile(
        'node',
        [
          '--input-type=module',
          '-e',
          "import('@flowguard/core/testing').then(m => { if (typeof m.createTestContext !== 'function') { console.error('createTestContext not found'); process.exit(1); } console.log('ok'); }).catch(e => { console.error(e.message); process.exit(1); })",
        ],
        p,
      );
      expect(res.code).toBe(0);
    }, 480000);

    it('@flowguard/core excludes integration and testing exports', async () => {
      const p = path.join(tmpDir, 'api-smoke-core');
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(
        path.join(p, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );
      const installArgs = ['install', '--no-audit', '--no-fund', tarballPath];
      assertSuccess(runFile('npm', installArgs, p), commandForLog('npm', installArgs));

      const res = runFile(
        'node',
        [
          '--input-type=module',
          '-e',
          "import('@flowguard/core').then(m => { if (typeof m.createTestContext !== 'undefined') { console.error('createTestContext leaked'); process.exit(1); } if (typeof m.plan !== 'undefined') { console.error('plan leaked'); process.exit(1); } if (typeof m.FlowGuardAuditPlugin !== 'undefined') { console.error('FlowGuardAuditPlugin leaked'); process.exit(1); } if (typeof m.resolvePolicy !== 'undefined') { console.error('resolvePolicy leaked'); process.exit(1); } if (typeof m.getPolicyPreset !== 'function') { console.error('getPolicyPreset missing'); process.exit(1); } console.log('ok'); }).catch(e => { console.error(e.message); process.exit(1); })",
        ],
        p,
      );
      expect(res.code).toBe(0);
    }, 480000);

    it('has expected files in tarball', async () => {
      const tmp = await installTarballForInspection('gov-list-');
      try {
        const files = await fs.readdir(
          path.join(tmp, 'node_modules', '@flowguard', 'core', 'dist'),
        );
        expect(files.length).toBeGreaterThan(10);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
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
