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
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CliArgs } from './install.js';

// ─── Mock: child_process ──────────────────────────────────────────────────────
// Must be called at module scope in each test file that needs it (vitest hoists mocks per-file).
// This function is exported for documentation but the actual vi.mock() MUST be in the consuming file.

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

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Repo root derived from this file's location (src/cli/install.test-helpers.ts).
 * Used by DEV_REPO_INVARIANTS tests to read the real repo filesystem.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * SSOT: Read version from VERSION file at repo root.
 */
export const VERSION = readFileSync(path.join(REPO_ROOT, 'VERSION'), 'utf-8').trim();

// ─── Temp Dir Management ──────────────────────────────────────────────────────

/** Mutable state: current temp directory (set in beforeEach). */
export let tmpDir: string;

/** Create a fresh temp directory. */
export async function createTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'gov-cli-test-'));
}

/** Clean up temp directory. */
export async function cleanTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best effort on Windows (file locks)
  }
}

// ─── Args Builders ────────────────────────────────────────────────────────────

/** Default args for repo-scope install targeting the cwd-relative .opencode/. */
export function repoArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    action: 'install',
    installScope: 'repo',
    policyMode: 'solo',
    force: false,
    coreTarball: undefined,
    ...overrides,
  };
}

/** Default args for global-scope install. */
export function globalArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    action: 'install',
    installScope: 'global',
    policyMode: 'solo',
    force: false,
    coreTarball: undefined,
    ...overrides,
  };
}

// ─── Shared Setup/Teardown ────────────────────────────────────────────────────

let originalCwd: string;
let originalConfigDir: string | undefined;
let originalRequireTestConfigDir: string | undefined;

/**
 * Call this in each test file's top-level scope to set up the shared
 * beforeEach/afterEach (tmpDir creation, cwd change, env vars).
 */
export function setupCliTestEnvironment(): void {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    originalCwd = process.cwd();
    originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    originalRequireTestConfigDir = process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
    process.chdir(tmpDir);
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
    process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalConfigDir !== undefined) {
      process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.OPENCODE_CONFIG_DIR;
    }
    if (originalRequireTestConfigDir !== undefined) {
      process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = originalRequireTestConfigDir;
    } else {
      delete process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR;
    }
    await cleanTmpDir(tmpDir);
  });
}

// ─── Mock Tarball Helper ──────────────────────────────────────────────────────

/** Create a mock tarball in the current tmpDir. */
export async function createMockTarball(version = VERSION): Promise<string> {
  const tarballPath = path.join(tmpDir, `flowguard-core-${version}.tgz`);
  await fs.writeFile(tarballPath, 'mock tarball content');
  return tarballPath;
}

// Vitest requires at least one test in *.test.ts files
import { describe, it, expect } from 'vitest';
describe('install-test-helpers', () => {
  it('exports shared test infrastructure', () => {
    expect(VERSION).toBeDefined();
    expect(typeof setupCliTestEnvironment).toBe('function');
    expect(typeof createMockTarball).toBe('function');
  });
});
