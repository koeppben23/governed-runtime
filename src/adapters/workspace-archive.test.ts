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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createArchive() {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-'));
  const restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
  cleanups.push(async () => {
    restore();
    await fs.rm(configDir, { recursive: true, force: true });
  });
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const initialized = await initWorkspace(path.resolve('.'), sessionId);
  await writeState(initialized.sessionDir, makeState('COMPLETE'));
  const archivePath = await archiveSession(initialized.fingerprint, sessionId);
  return { ...initialized, sessionId, archivePath };
}

async function extract(archivePath: string): Promise<string> {
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-v2-extract-'));
  cleanups.push(async () => fs.rm(destination, { recursive: true, force: true }));
  await promisify(execFile)('tar', ['xzf', archivePath, '-C', destination]);
  return destination;
}

describe('Archive Layout v2', () => {
  it('exports complete canonical evidence into the structured archive tree', async () => {
    const { archivePath, sessionId } = await createArchive();
    const root = path.join(await extract(archivePath), sessionId);
    const manifest = JSON.parse(
      await fs.readFile(path.join(root, 'archive-manifest.json'), 'utf8'),
    );
    expect(manifest.layoutVersion).toBe(2);
    expect(manifest.rawIncluded).toBe(true);
    expect(manifest.includedFiles).toContain('state/session-state.json');
    expect(manifest.includedFiles).toContain('audit/decision-receipts.v1.json');
    await expect(fs.access(path.join(root, 'state/session-state.json'))).resolves.toBeUndefined();
  });

  it('verifies the tarball independently of later live-session mutations', async () => {
    const { fingerprint, sessionId, sessionDir } = await createArchive();
    await fs.writeFile(path.join(sessionDir, 'session-state.json'), 'tampered', 'utf8');
    expect((await verifyArchive(fingerprint, sessionId)).passed).toBe(true);
  });
});
