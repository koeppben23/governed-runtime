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
    await fs.copyFile(path.join(REPO_ROOT, `flowguard-core-${VERSION}.tgz`), tarballPath);
  });

  afterAll(async () => {
    await cleanTmpDir(tmpDir);
  });

  describe('Tarball', () => {
    it('package.json has @opentelemetry/api in dependencies', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gov-pkg-'));
      execSync(`tar -xzf "${tarballPath}" -C ${tmp}`);
      const pkg = JSON.parse(await fs.readFile(path.join(tmp, 'package', 'package.json'), 'utf-8'));
      expect(pkg.dependencies['@opentelemetry/api']).toBeDefined();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it('tarball can be installed in fresh project', async () => {
      const p = path.join(tmpDir, 'install-test');
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(
        path.join(p, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );
      const res = run(`npm install "${tarballPath}"`, p);
      expect(res.code).toBe(0);
    });

    it('can import @flowguard/core after install', async () => {
      const p = path.join(tmpDir, 'import-test');
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(
        path.join(p, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' }),
      );
      run(`npm install "${tarballPath}"`, p);
      const res = run(
        `node -e "import('@flowguard/core').then(() => console.log('ok')).catch(e => { console.error(e.message); process.exit(1); })"`,
        p,
      );
      expect(res.code).toBe(0);
    });

    it('has expected files in tarball', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gov-list-'));
      execSync(`tar -xzf "${tarballPath}" -C ${tmp}`);
      const files = await fs.readdir(path.join(tmp, 'package', 'dist'));
      expect(files.length).toBeGreaterThan(10);
      await fs.rm(tmp, { recursive: true, force: true });
    });
  });
});
