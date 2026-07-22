/**
 * @module cli/opencode-runtime-gate-install.test
 * @description Negative-path + happy-path tests for the install-time
 * instruction-source compatibility gate (write-but-refuse posture).
 *
 * @test-policy HAPPY, BAD — negative path is the governance-critical case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';

// child_process mock mirrors install-doctor.test.ts so dependency install and
// the version probe both resolve deterministically.
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
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
  return { ...original, execFileSync: vi.fn(mockImpl), execSync: vi.fn(mockImpl) };
});

// Compatibility authority mock: lets each test choose the classification while
// keeping the deny-list empty in production.
const compatMock = vi.hoisted(() => ({ compatibility: 'compatible' as string }));
vi.mock('./opencode-runtime-compat.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./opencode-runtime-compat.js')>();
  return {
    ...original,
    classifyOpenCodeRuntime: vi.fn(() => ({ compatibility: compatMock.compatibility })),
  };
});

import { install } from './install-command.js';
import {
  repoArgs,
  createMockTarball,
  setupCliTestEnvironment,
} from './install-test-helpers.test.js';

setupCliTestEnvironment();

describe('install instruction-source compatibility gate', () => {
  beforeEach(() => {
    compatMock.compatibility = 'compatible';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('HAPPY — compatible/unknown runtime installs cleanly', () => {
    it('produces no compat error and writes the mandates artifact', async () => {
      compatMock.compatibility = 'compatible';
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: tarball }));

      expect(result.errors).toEqual([]);
      expect(
        result.ops.some((o) => o.path.endsWith('flowguard-mandates.md') && o.action === 'written'),
      ).toBe(true);
    });
  });

  describe('BAD — known-incompatible runtime: write but refuse active', () => {
    it('writes artifacts but surfaces the reason error and a warning', async () => {
      compatMock.compatibility = 'known-incompatible';
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: tarball }));

      // write: mandates artifact was written as part of the install
      expect(
        result.ops.some((o) => o.path.endsWith('flowguard-mandates.md') && o.action === 'written'),
      ).toBe(true);

      // refuse-active: blocking error carrying the reason + a warning
      expect(result.errors.some((e) => e.includes('does not resolve instruction sources'))).toBe(
        true,
      );
      expect(result.warnings.some((w) => w.includes('mandates are NOT active'))).toBe(true);
    });
  });
});
