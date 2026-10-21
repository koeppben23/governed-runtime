/**
 * @module cli/iso27001-java-demo.smoke.test
 * @description Real-CLI wrapper smoke for the Java demo ISO projection.
 *
 * The offline ISO demo materializes a real, verified completion export in a
 * temporary foreign repository. This test points the Java wrapper at that
 * workspace and at the repository's built CLI through the actual repo-install
 * path (`.opencode/node_modules/@flowguard/core/dist/cli/install.js`). It
 * proves wrapper resolution, the real inspect command, digest consistency, and
 * publication without requiring a live model or a completed Java `/export`.
 *
 * The Java demo's own live `/export` acceptance remains manual.
 *
 * @test-policy HAPPY, BAD — gated integration; fails closed in CI.
 * @version v1
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isTarAvailable } from '../integration/test-helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli', 'install.js');
const ISO_DEMO = path.join(REPO_ROOT, 'demos', 'iso27001-evidence-mapping', 'run-demo.mjs');
const WRAPPER = path.join(REPO_ROOT, 'demos', 'java-task-manager', 'run-iso-mapping.sh');
const MAPPING = path.join(REPO_ROOT, 'demos', 'java-task-manager', 'iso27001-demo-mapping.json');
const SESSION = 'ses_iso27001_demo_session_0001';
const HAS_BUILT_CLI = existsSync(CLI_ENTRY);
const tarOk = await isTarAvailable();
const CAN_RUN = HAS_BUILT_CLI && tarOk && process.platform !== 'win32';

if (!CAN_RUN && process.env['CI']) {
  describe('iso27001 Java wrapper smoke (CI fail-closed guard)', () => {
    it('CI must provide the built CLI, tar, and a POSIX shell', () => {
      throw new Error(
        `wrapper smoke prerequisites missing: builtCli=${String(HAS_BUILT_CLI)} tar=${String(tarOk)} platform=${process.platform}`,
      );
    });
  });
}

describe.skipIf(!CAN_RUN)('iso27001 Java wrapper smoke', () => {
  it('resolves the repo-installed CLI and publishes a verified digest-consistent pair', async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'iso-java-wrapper-smoke-'));
    const demoRoot = path.join(sandbox, 'iso-demo');
    const workspace = path.join(demoRoot, 'foreign-repo');
    const configDir = path.join(demoRoot, 'opencode-config');
    const reports = path.join(sandbox, 'reports');
    try {
      const demo = spawnSync(process.execPath, [ISO_DEMO, '--root', demoRoot, '--keep'], {
        encoding: 'utf8',
        timeout: 180_000,
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      expect(demo.status, demo.stderr).toBe(0);
      expect(existsSync(workspace)).toBe(true);
      expect(existsSync(configDir)).toBe(true);

      await fs.writeFile(path.join(workspace, 'pom.xml'), '<project/>\n', 'utf8');
      await fs.copyFile(WRAPPER, path.join(workspace, 'run-iso-mapping.sh'));
      await fs.copyFile(MAPPING, path.join(workspace, 'iso27001-demo-mapping.json'));
      const installedRoot = path.join(workspace, '.opencode', 'node_modules', '@flowguard');
      await fs.mkdir(installedRoot, { recursive: true });
      await fs.symlink(REPO_ROOT, path.join(installedRoot, 'core'), 'dir');

      const result = spawnSync(
        'bash',
        [
          path.join(workspace, 'run-iso-mapping.sh'),
          '--session',
          SESSION,
          '--output-root',
          reports,
        ],
        {
          cwd: workspace,
          encoding: 'utf8',
          timeout: 120_000,
          env: {
            ...process.env,
            NODE: process.execPath,
            OPENCODE_CONFIG_DIR: configDir,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Export:     verified_snapshot');
      expect(result.stdout).toContain('.opencode/node_modules/@flowguard/core/dist/cli/install.js');
      expect(result.stdout).toContain('Evidence-to-control mapping only.');

      const finalDir = path.join(reports, SESSION);
      const jsonPath = path.join(finalDir, 'iso27001-report.json');
      const mdPath = path.join(finalDir, 'iso27001-report.md');
      const json = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as {
        reportSchemaVersion: string;
        evidencePackage: { verification: string; packageSha256: string };
        organization: { mappingDigest: string };
        reportDigest: string;
        controls: Array<{ controlRef: { controlId: string }; status: string }>;
      };
      const markdown = await fs.readFile(mdPath, 'utf8');
      expect(json.reportSchemaVersion).toBe('iso27001-evidence-report.v1');
      expect(json.evidencePackage.verification).toBe('verified_snapshot');
      expect(markdown).toContain(json.reportDigest);
      expect(markdown).toContain(json.organization.mappingDigest);
      expect(markdown).toContain(json.evidencePackage.packageSha256);
      expect(json.controls.some((control) => control.controlRef.controlId === 'A.8.29')).toBe(true);
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  }, 300_000);
});
