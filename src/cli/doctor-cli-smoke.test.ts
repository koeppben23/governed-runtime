/**
 * @module cli/doctor-cli-smoke.test
 * @description Build-dependent smoke tests for the `doctor` CLI exit code (#423).
 *
 * doctor() validates the shipped `dist/` executable surface of the *running*
 * FlowGuard package (package.json `bin` SSOT). A successful `main(['doctor'])`
 * exit therefore requires a built `dist/` — these assertions belong in the
 * build-dependent `smoke` project, not the no-build `unit` project (see
 * vitest.config.ts project taxonomy). The config-health logic itself is covered
 * build-independently in install-doctor.test.ts and install-cli.test.ts.
 *
 * @test-policy HAPPY, EDGE — full-doctor success exit-code paths over built dist.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import { main } from './install.js';
import { tmpDir, createMockTarball, setupCliTestEnvironment } from './install-test-helpers.test.js';

// ─── Mock: child_process ──────────────────────────────────────────────────────
// Stubs auto-install/version probes and the plugin-import execSync so doctor's
// config-health path is exercised without spawning real processes. The shipped-
// executable check reads the real built dist via node:fs (NOT mocked). Inlined
// (not via childProcessMockFactory) because vi.mock is hoisted above imports.
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
  return {
    ...original,
    execFileSync: vi.fn(mockImpl),
    execSync: vi.fn(mockImpl),
  };
});

setupCliTestEnvironment();

describe('cli/main doctor exit code (build-dependent, #423)', () => {
  describe('HAPPY', () => {
    it('returns 0 for doctor after install (repo scope)', async () => {
      const tarball = await createMockTarball();
      await main(['install', '--install-scope', 'repo', '--core-tarball', tarball]);
      const code = await main(['doctor', '--install-scope', 'repo']);
      expect(code).toBe(0);
    });
  });

  describe('EDGE', () => {
    it('doctor returns 0 when only warn checks present (no errors)', async () => {
      const tarball = await createMockTarball();
      await main(['install', '--install-scope', 'repo', '--core-tarball', tarball]);
      // Overwrite opencode.json to simulate desktop-owned config missing task hardening
      const ocPath = path.join(tmpDir, 'opencode.json');
      await fs.writeFile(
        ocPath,
        JSON.stringify(
          {
            plugin: ['flowguard-audit'],
            instructions: ['.opencode/flowguard-mandates.md'],
          },
          null,
          2,
        ),
        'utf-8',
      );
      const code = await main(['doctor', '--install-scope', 'repo']);
      // warn for task-hardening, but no hard error → exit 0
      expect(code).toBe(0);
    });
  });
});
