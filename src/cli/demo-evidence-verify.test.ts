/**
 * @module cli/demo-evidence-verify.test
 * @description Smoke contract for the standalone demo evidence-package
 * verifier. Build-dependent: the verifier imports the canonical archive
 * primitives from the built `@flowguard/core`, so this test runs in the smoke
 * project after `npm run build` (see vitest.config.ts).
 *
 * The fixture is a real package produced through the real `/export` archive
 * path (`archiveCompletionExport`); tamper cases repack the tarball through the
 * `tar` CLI and recompute the sidecar so each failure isolates the check under
 * test instead of tripping the checksum first.
 *
 * @test-policy HAPPY, BAD, CORNER
 * @version v1
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { BINDING, FIXED_TIME, makeState } from '../fixtures.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import { writeState } from '../adapters/persistence.js';
import { archiveCompletionExport } from '../adapters/workspace/archive.js';
import { archiveSession, initWorkspace } from '../adapters/workspace/index.js';
import { withTestEnv } from '../integration/test-helpers.js';

const execFileAsync = promisify(execFile);

const VERIFIER = path.join(
  process.cwd(),
  'demos',
  'java-task-manager',
  'verify-evidence-package.mjs',
);
const WORKTREE = process.cwd();
const SESSION_A = '550e8400-e29b-41d4-a716-4466554400a1';
const SESSION_B = '550e8400-e29b-41d4-a716-4466554400b2';
const FLOWGUARD_A = '550e8400-e29b-41d4-a716-4466554400c1';
const FLOWGUARD_B = '550e8400-e29b-41d4-a716-4466554400c2';

const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-demo-evidence-'));
  const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
  cleanups.push(async () => {
    restore();
    await fs.rm(configDir, { recursive: true, force: true });
  });
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function writeEvidenceState(
  sessionId: string,
  flowguardSessionId: string,
): Promise<{ fingerprint: string; sessionDir: string }> {
  const initialized = await initWorkspace(WORKTREE, sessionId);
  await writeState(
    initialized.sessionDir,
    makeState('COMPLETE', {
      id: flowguardSessionId,
      flowguardSessionId,
      binding: {
        ...BINDING,
        hostSessionId: sessionId,
        fingerprint: initialized.fingerprint,
        worktree: WORKTREE,
      },
      transition: {
        from: 'EXPORT_READY',
        to: 'COMPLETE',
        event: 'EXPORT_MATERIALIZED',
        at: FIXED_TIME,
      },
    }),
  );
  await appendAuditEvent(initialized.sessionDir, {
    id: randomUUID(),
    flowguardSessionId,
    hostSessionId: sessionId,
    phase: 'COMPLETE',
    event: 'lifecycle:session_completed',
    occurredAt: FIXED_TIME,
    actor: 'system',
    detail: { kind: 'lifecycle', action: 'session_completed', finalPhase: 'COMPLETE' },
  });
  return initialized;
}

async function buildRawPackage(sessionId: string, flowguardSessionId: string): Promise<string> {
  const initialized = await writeEvidenceState(sessionId, flowguardSessionId);
  return archiveCompletionExport(initialized.fingerprint, sessionId);
}

async function runVerifier(
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [VERIFIER, ...args], {
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex');
}

async function repack(
  packagePath: string,
  sessionId: string,
  mutate: (sessionRoot: string) => Promise<void>,
): Promise<void> {
  const extraction = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-demo-evidence-repack-'));
  const members = (await execFileAsync('tar', ['-tzf', packagePath], { timeout: 30_000 })).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  await execFileAsync('tar', ['-xzf', packagePath, '-C', extraction], { timeout: 30_000 });
  await mutate(path.join(extraction, sessionId));
  await execFileAsync(
    'tar',
    ['--format=ustar', '-czf', packagePath, '-C', extraction, ...members],
    { timeout: 30_000, env: { ...process.env, COPYFILE_DISABLE: '1' } },
  );
  await fs.writeFile(
    `${packagePath}.sha256`,
    `${await sha256(packagePath)}  ${path.basename(packagePath)}\n`,
  );
  await fs.rm(extraction, { recursive: true, force: true });
}

async function writeSharingConfig(): Promise<void> {
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  if (!configDir) throw new Error('OPENCODE_CONFIG_DIR must be set by the test env');
  await fs.writeFile(
    path.join(configDir, 'flowguard.json'),
    JSON.stringify({
      schemaVersion: 'v1',
      archive: { redaction: { allowedModes: ['basic'], allowRawExport: false } },
    }),
    'utf8',
  );
}

describe('demo evidence package verifier', () => {
  describe('HAPPY', () => {
    it('verifies a real raw export package as the expected session', async () => {
      const packagePath = await buildRawPackage(SESSION_A, FLOWGUARD_A);

      const result = await runVerifier([
        packagePath,
        '--expect-session',
        SESSION_A,
        '--expect-flow',
        'development',
        '--expect-phase',
        'COMPLETE',
      ]);

      expect(result.stdout).toContain('VERIFIED');
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`session: ${SESSION_A}`);
    });
  });

  describe('BAD', () => {
    it('rejects a package with changed file bytes', async () => {
      const packagePath = await buildRawPackage(SESSION_A, FLOWGUARD_A);
      await repack(packagePath, SESSION_A, async (sessionRoot) => {
        const statePath = path.join(sessionRoot, 'state', 'session-state.json');
        const original = await fs.readFile(statePath, 'utf-8');
        await fs.writeFile(statePath, `${original}\n`, 'utf-8');
      });

      const result = await runVerifier([packagePath, '--expect-session', SESSION_A]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('file_digest_mismatch');
    });

    it('rejects manipulated manifest metadata', async () => {
      const packagePath = await buildRawPackage(SESSION_A, FLOWGUARD_A);
      await repack(packagePath, SESSION_A, async (sessionRoot) => {
        const manifestPath = path.join(sessionRoot, 'archive-manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        manifest.policyMode = 'regulated';
        await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');
      });

      const result = await runVerifier([packagePath, '--expect-session', SESSION_A]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('content_digest_mismatch');
      expect(result.stdout).toContain('manifest_policy_mode_mismatch');
    });

    it('rejects a valid package assigned to a different session', async () => {
      const packagePath = await buildRawPackage(SESSION_B, FLOWGUARD_B);

      const result = await runVerifier([packagePath, '--expect-session', SESSION_A]);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('session_identity_mismatch');
    });

    it('fails closed with a usage error when no expectation is provided', async () => {
      const packagePath = await buildRawPackage(SESSION_A, FLOWGUARD_A);

      const result = await runVerifier([packagePath]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--expect-session is required');
    });
  });

  describe('CORNER', () => {
    it('refuses to present a redacted sharing archive as fully verifiable raw evidence', async () => {
      const initialized = await writeEvidenceState(SESSION_A, FLOWGUARD_A);
      await writeSharingConfig();
      const packagePath = await archiveSession(initialized.fingerprint, SESSION_A, {
        redactionMode: 'basic',
        includeRaw: false,
      });

      const refused = await runVerifier([packagePath, '--expect-session', SESSION_A]);
      expect(refused.code).toBe(3);
      expect(refused.stdout).toContain('sharing_archive_not_verifiable');

      const accepted = await runVerifier([
        packagePath,
        '--expect-session',
        SESSION_A,
        '--expect-sharing',
      ]);
      expect(accepted.code).toBe(0);
      expect(accepted.stdout).toContain('NOT FULLY VERIFIABLE');
    });
  });
});
