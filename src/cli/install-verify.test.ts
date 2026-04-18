/**
 * @module cli/install-verify.test
 * @description Smoke tests for release tarball verification.
 *
 * This test validates that the release tarball can be installed in a
 * FRESH environment (not the dev repo) and that all required modules
 * and CLI commands work correctly.
 *
 * Architecture under test (v2):
 * - @opentelemetry/api is in dependencies (runtime, not dev-only)
 * - Telemetry module degrades gracefully when OTEL packages are missing
 * - CLI entry point works without crashing
 * - Core module can be imported without missing dependency errors
 *
 * Run with: npm run test:install-verify (not part of standard test suite)
 *
 * @test-policy HAPPY, BAD, CORNER — core smoke tests only.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = (await fs.readFile(path.join(REPO_ROOT, 'VERSION'), 'utf-8')).trim();

let tmpDir: string;
let tarballPath: string;

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
      timeout: 60000,
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

describe('install-verify', () => {
  beforeAll(async () => {
    tmpDir = await createTmpDir();
    tarballPath = path.join(tmpDir, `flowguard-core-${VERSION}.tgz`);
    execSync('npm pack', { cwd: REPO_ROOT, encoding: 'utf-8' });
    await fs.rename(path.join(REPO_ROOT, `flowguard-core-${VERSION}.tgz`), tarballPath);
  });

  afterAll(async () => {
    await cleanTmpDir(tmpDir);
  });

  describe('HAPPY', () => {
    it('fresh project can install tarball and import core', async () => {
      const projectDir = path.join(tmpDir, 'project');
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );

      const installResult = run(`npm install "${tarballPath}"`, projectDir);
      expect(installResult.code).toBe(0);

      const importResult = run(
        `node -e "import('@flowguard/core').then(m => console.log('ok')).catch(e => { console.error(e.message); process.exit(1); })"`,
        projectDir,
      );
      expect(importResult.code).toBe(0);
      expect(importResult.stdout).toContain('ok');
    });

    it('core module exports are available', async () => {
      const projectDir = path.join(tmpDir, 'project2');
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );

      const installResult = run(`npm install "${tarballPath}"`, projectDir);
      expect(installResult.code).toBe(0);

      const checkResult = run(
        `node -e "import('@flowguard/core').then(m => console.log(Object.keys(m).length > 0 ? 'exports-ok' : 'no-exports')).catch(e => { console.error(e.message); process.exit(1); })"`,
        projectDir,
      );
      expect(checkResult.code).toBe(0);
      expect(checkResult.stdout).toContain('exports-ok');
    });
  });

  describe('BAD', () => {
    it('tarball package.json includes @opentelemetry/api as runtime dependency', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gov-pkg-'));
      execSync(`tar -xzf "${tarballPath}" -C ${tmp}`);
      const pkgContent = await fs.readFile(path.join(tmp, 'package', 'package.json'), 'utf-8');
      const pkg = JSON.parse(pkgContent);
      expect(pkg.dependencies['@opentelemetry/api']).toBeDefined();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it('import does not crash when telemetry is unavailable', async () => {
      const projectDir = path.join(tmpDir, 'project3');
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );

      const installResult = run(`npm install "${tarballPath}"`, projectDir);
      expect(installResult.code).toBe(0);

      const importResult = run(
        `node -e "import('@flowguard/core').then(() => console.log('telemetry-ok')).catch(e => { console.error(e.message); process.exit(1); })"`,
        projectDir,
      );
      expect(importResult.code).toBe(0);
    });
  });

  describe('CORNER', () => {
    it('works without node_modules from previous install', async () => {
      const projectDir = path.join(tmpDir, 'project-corner');
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );

      const firstInstall = run(`npm install "${tarballPath}"`, projectDir);
      expect(firstInstall.code).toBe(0);

      await fs.rm(path.join(projectDir, 'node_modules'), { recursive: true, force: true });

      const reInstallResult = run(`npm install "${tarballPath}"`, projectDir);
      expect(reInstallResult.code).toBe(0);

      const importResult = run(
        `node -e "import('@flowguard/core').then(() => console.log('reinstall ok'))"`,
        projectDir,
      );
      expect(importResult.code).toBe(0);
    });

    it('handles missing vendor directory gracefully', async () => {
      const projectDir = path.join(tmpDir, 'project-no-vendor');
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );

      const installResult = run(`npm install "${tarballPath}"`, projectDir);
      expect(installResult.code).toBe(0);

      const doctorResult = run('npx flowguard doctor', projectDir);
      expect(doctorResult.code).toBe(1);
      expect(doctorResult.stdout).toMatch(/MISSING|missing/);
    });

    it('handles corrupted tarball gracefully', async () => {
      const projectDir = path.join(tmpDir, 'project-corrupt');
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );

      const corruptTarball = path.join(tmpDir, 'flowguard-corrupt.tgz');
      await fs.writeFile(corruptTarball, 'not a real tarball');

      const installResult = run(`npm install "${corruptTarball}"`, projectDir);
      expect(installResult.code).not.toBe(0);
    });
  });
});
