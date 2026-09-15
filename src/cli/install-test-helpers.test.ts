/**
 * @module cli/install.test-helpers
 * @description Shared test infrastructure for the split CLI installer test suite.
 *
 * Provides: temp directory management, default args builders, shared constants,
 * and child_process mock setup for auto-install behavior.
 */

import { beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CliArgs } from './install-types.js';
import { withTestEnv } from '../integration/test-helpers.js';

/**
 * Returns the vi.mock factory for node:child_process.
 * Usage in each test file:
 * ```ts
 * vi.mock('node:child_process', childProcessMockFactory);
 * ```
 */
export function childProcessMockFactory() {
  return async (importOriginal: () => Promise<typeof import('node:child_process')>) => {
    const original = await importOriginal();
    const mockImpl = (
      cmd: string,
      args?: string[] | { cwd?: string; stdio?: unknown; timeout?: number },
      opts?: { cwd?: string; stdio?: unknown; timeout?: number },
    ) => {
      const isVersion =
        typeof cmd === 'string' &&
        (cmd.includes('--version') || (Array.isArray(args) && args[0] === '--version'));
      if (isVersion) return Buffer.from('1.0.0\n');
      const cwd =
        (typeof opts === 'object' && opts?.cwd) ||
        (typeof args === 'object' && !Array.isArray(args) && args?.cwd);
      if (cwd) {
        const corePath = path.join(cwd, 'node_modules', '@flowguard', 'core');
        mkdirSync(corePath, { recursive: true });
        return Buffer.from('');
      }
      return Buffer.from('');
    };
    return {
      ...original,
      execFileSync: vi.fn(mockImpl),
      execSync: vi.fn(mockImpl),
    };
  };
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const VERSION = readFileSync(path.join(REPO_ROOT, 'VERSION'), 'utf-8').trim();

export let tmpDir: string;

export async function createTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'gov-cli-test-'));
}

export async function cleanTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best effort on Windows (file locks)
  }
}

export function repoArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    action: 'install',
    installScope: 'repo',
    scopeSource: 'default',
    policyMode: 'solo',
    force: false,
    coreTarball: undefined,
    ...overrides,
  };
}

export function globalArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    action: 'install',
    installScope: 'global',
    scopeSource: 'default',
    policyMode: 'solo',
    force: false,
    coreTarball: undefined,
    ...overrides,
  };
}

let originalCwd: string;
let restoreEnv: (() => void) | undefined;

export function setupCliTestEnvironment(): void {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    restoreEnv = withTestEnv({
      OPENCODE_CONFIG_DIR: tmpDir,
      FLOWGUARD_REQUIRE_TEST_CONFIG_DIR: '1',
      FLOWGUARD_INSTALL_LOCK_PATH: path.join(tmpDir, '.install.lock'),
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    restoreEnv?.();
    restoreEnv = undefined;
    await cleanTmpDir(tmpDir);
  });
}

export async function createMockTarball(
  version = VERSION,
  options: { writeChecksum?: boolean } = {},
): Promise<string> {
  const tarballPath = path.join(tmpDir, `flowguard-core-${version}.tgz`);
  const content = 'mock tarball content';
  await fs.writeFile(tarballPath, content);
  if (options.writeChecksum !== false) {
    const hash = createHash('sha256').update(content, 'utf-8').digest('hex');
    await fs.writeFile(
      path.join(tmpDir, 'checksums.sha256'),
      `${hash}  ${path.basename(tarballPath)}\n`,
    );
  }
  return tarballPath;
}

import { describe, it, expect } from 'vitest';
describe('install-test-helpers', () => {
  it('exports shared test infrastructure', () => {
    expect(VERSION).toBeDefined();
    expect(typeof setupCliTestEnvironment).toBe('function');
    expect(typeof createMockTarball).toBe('function');
  });
});
