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
import { execSync, execFileSync } from 'node:child_process';
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

function run(cmd: string, cwd: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(cmd, {
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
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gov-pkg-'));
      execFileSync('tar', ['-xzf', tarballPath, '-C', tmp]);
      const pkg = JSON.parse(await fs.readFile(path.join(tmp, 'package', 'package.json'), 'utf-8'));
      expect(pkg.dependencies['@opentelemetry/api']).toBeDefined();
      expect(pkg.dependencies['@opentelemetry/api']).toMatch(/^\^1\./);
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it('package.json has OTEL SDK packages in optionalDependencies', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gov-pkg-'));
      execFileSync('tar', ['-xzf', tarballPath, '-C', tmp]);
      const pkg = JSON.parse(await fs.readFile(path.join(tmp, 'package', 'package.json'), 'utf-8'));
      expect(pkg.optionalDependencies).toBeDefined();
      expect(pkg.optionalDependencies['@opentelemetry/sdk-node']).toBeDefined();
      expect(pkg.optionalDependencies['@opentelemetry/exporter-trace-otlp-http']).toBeDefined();
      expect(pkg.optionalDependencies['@opentelemetry/auto-instrumentations-node']).toBeDefined();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it('installs with --omit=optional without crashing', async () => {
      const p = path.join(tmpDir, 'omit-optional-test');
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(
        path.join(p, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );
      // Install without optional dependencies
      const command = `npm install --omit=optional --no-audit --no-fund "${tarballPath}"`;
      const res = run(command, p);
      assertSuccess(res, command);
    }, 240000);

    it('imports core module with --omit=optional', async () => {
      const p = path.join(tmpDir, 'omit-optional-import-test');
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(
        path.join(p, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );
      // First install without optional
      const installCmd = `npm install --omit=optional --no-audit --no-fund "${tarballPath}"`;
      const install = run(installCmd, p);
      assertSuccess(install, installCmd);
      // Then import - should not crash even without optional OTEL packages
      const res = run(
        `node -e "import('@flowguard/core').then(m => console.log('ok')).catch(e => { console.error(e.message); process.exit(1); })"`,
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
      const command = `npm install --no-audit --no-fund "${tarballPath}"`;
      const res = run(command, p);
      assertSuccess(res, command);
    }, 240000);

    it('can import @flowguard/core after install', async () => {
      const p = path.join(tmpDir, 'import-test');
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(
        path.join(p, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );
      const installCommand = `npm install --no-audit --no-fund "${tarballPath}"`;
      const install = run(installCommand, p);
      assertSuccess(install, installCommand);
      const res = run(
        `node -e "import('@flowguard/core').then(() => console.log('ok')).catch(e => { console.error(e.message); process.exit(1); })"`,
        p,
      );
      expect(res.code).toBe(0);
    }, 240000);

    it('has expected files in tarball', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gov-list-'));
      execFileSync('tar', ['-xzf', tarballPath, '-C', tmp]);
      const files = await fs.readdir(path.join(tmp, 'package', 'dist'));
      expect(files.length).toBeGreaterThan(10);
      await fs.rm(tmp, { recursive: true, force: true });
    });
  });
});
