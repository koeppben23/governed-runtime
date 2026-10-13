/**
 * @module cli/iso27001-demo.smoke.test
 * @description Executes the offline ISO/IEC 27001:2022 demo end-to-end against
 * the built CLI. Skips locally when `dist/` or `tar` is unavailable, but fails
 * closed in CI so the demo can never be skipped silently after the build step.
 *
 * @test-policy HAPPY, BAD — positive execution plus the CI fail-closed guard.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTarAvailable } from '../integration/test-helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli', 'install.js');
const DEMO_SCRIPT = path.join(REPO_ROOT, 'demos', 'iso27001-evidence-mapping', 'run-demo.mjs');
const HAS_BUILT_CLI = existsSync(CLI_ENTRY);
const tarOk = await isTarAvailable();

if ((!HAS_BUILT_CLI || !tarOk) && process.env['CI']) {
  describe('iso27001 offline demo smoke (CI fail-closed guard)', () => {
    it('CI must execute the demo against a built CLI and available tar', () => {
      throw new Error(
        `demo prerequisites missing in CI: builtCli=${String(HAS_BUILT_CLI)} tar=${String(tarOk)}`,
      );
    });
  });
}

const describeSmoke = HAS_BUILT_CLI && tarOk ? describe : describe.skip;

describeSmoke('iso27001 offline demo smoke', () => {
  it('runs the positive, negative and tamper scenarios with exit 0', async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'iso-demo-smoke-'));
    const runRoot = path.join(sandbox, 'run');
    try {
      const result = spawnSync(process.execPath, [DEMO_SCRIPT, '--root', runRoot], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, FORCE_COLOR: '0' },
        timeout: 120_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('all scenarios passed');
      expect(result.stdout).toContain('PASS A.8.32 change-control is EVIDENCE_LINKED_VERIFIED');
      expect(result.stdout).toContain('PASS aggregate report binding is NOT_VERIFIED');
      expect(result.stdout).toContain('PASS tampered package exits 2');
      expect(result.stderr).toBe('');
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  }, 180_000);
});
