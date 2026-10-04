import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { archiveSession, initWorkspace, verifyArchive } from './workspace/index.js';
import { writeState } from './persistence.js';
import { makeState } from '../fixtures.js';
import { withTestEnv } from '../integration/test-helpers.js';

let restore: (() => void) | null = null;
let configDir = '';
afterEach(async () => {
  restore?.();
  restore = null;
  if (configDir) await fs.rm(configDir, { recursive: true, force: true });
});

async function archiveFixture() {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-v2-'));
  restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
  // Write config with raw export enabled for archive verification tests.
  await fs.writeFile(
    path.join(configDir, 'flowguard.json'),
    JSON.stringify({
      schemaVersion: 'v1',
      archive: { redaction: { allowedModes: ['none'], allowRawExport: true } },
    }),
    'utf8',
  );
  const sessionId = '550e8400-e29b-41d4-a716-446655440001';
  const initialized = await initWorkspace(path.resolve('.'), sessionId);
  await writeState(initialized.sessionDir, makeState('COMPLETE'));
  await archiveSession(initialized.fingerprint, sessionId, {
    redactionMode: 'none',
    includeRaw: true,
  });
  return {
    fingerprint: initialized.fingerprint,
    sessionId,
    archivePath: path.join(
      configDir,
      'workspaces',
      initialized.fingerprint,
      'sessions',
      'archive',
      `${sessionId}.tar.gz`,
    ),
  };
}

describe('verifyArchive Archive Layout v2', () => {
  it('accepts a clean structured raw-evidence archive', async () => {
    const { fingerprint, sessionId } = await archiveFixture();
    expect((await verifyArchive(fingerprint, sessionId)).passed).toBe(true);
  });

  it('rejects a tampered archive checksum', async () => {
    const { fingerprint, sessionId, archivePath } = await archiveFixture();
    await fs.writeFile(
      `${archivePath}.sha256`,
      `${'0'.repeat(64)}  ${path.basename(archivePath)}\n`,
    );
    const result = await verifyArchive(fingerprint, sessionId);
    expect(result.findings.some((finding) => finding.code === 'archive_checksum_mismatch')).toBe(
      true,
    );
  });

  it('rejects an unreadable archive tarball', async () => {
    const { fingerprint, sessionId, archivePath } = await archiveFixture();
    await fs.writeFile(archivePath, 'not a tarball', 'utf8');
    expect((await verifyArchive(fingerprint, sessionId)).passed).toBe(false);
  });
});
