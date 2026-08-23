import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectArchiveTar } from './archive-tar.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createArchive(
  members: string[],
): Promise<{ archivePath: string; sessionId: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-tar-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const sessionDir = path.join(root, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, 'payload.txt'), 'payload', 'utf8');
  await fs.writeFile(path.join(sessionDir, 'undeclared.txt'), 'undeclared', 'utf8');
  await fs.writeFile(path.join(sessionDir, '._payload.txt'), 'metadata', 'utf8');
  await fs.symlink('payload.txt', path.join(sessionDir, 'payload-link'));
  await fs.link(path.join(sessionDir, 'payload.txt'), path.join(sessionDir, 'payload-hardlink'));
  const archivePath = path.join(root, 'archive.tar.gz');
  await promisify(execFile)(
    'tar',
    ['--format=ustar', '-czf', archivePath, '-C', root, ...members],
    {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    },
  );
  return { archivePath, sessionId };
}

describe('inspectArchiveTar', () => {
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const payload = `${sessionId}/payload.txt`;

  it('accepts exactly the declared regular members', async () => {
    const { archivePath } = await createArchive([payload]);
    await expect(inspectArchiveTar(archivePath, sessionId, [payload])).resolves.toEqual({
      kind: 'ok',
    });
  });

  it('rejects undeclared regular members and AppleDouble metadata', async () => {
    const { archivePath: undeclaredArchive } = await createArchive([
      payload,
      `${sessionId}/undeclared.txt`,
    ]);
    const { archivePath: appleDoubleArchive } = await createArchive([
      payload,
      `${sessionId}/._payload.txt`,
    ]);

    await expect(inspectArchiveTar(undeclaredArchive, sessionId, [payload])).resolves.toMatchObject(
      {
        kind: 'blocked',
        reason: expect.stringContaining('undeclared'),
      },
    );
    await expect(
      inspectArchiveTar(appleDoubleArchive, sessionId, [payload]),
    ).resolves.toMatchObject({
      kind: 'blocked',
    });
  });

  it('rejects symlink and hardlink members', async () => {
    const { archivePath: symlinkArchive } = await createArchive([
      payload,
      `${sessionId}/payload-link`,
    ]);
    const { archivePath: hardlinkArchive } = await createArchive([
      payload,
      `${sessionId}/payload-hardlink`,
    ]);

    await expect(inspectArchiveTar(symlinkArchive, sessionId)).resolves.toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('non-regular'),
    });
    await expect(inspectArchiveTar(hardlinkArchive, sessionId)).resolves.toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('non-regular'),
    });
  });

  it('rejects duplicate, missing, and unsafe member paths', async () => {
    const { archivePath: duplicateArchive } = await createArchive([payload, payload]);
    const { archivePath: wrongRootArchive } = await createArchive([payload]);

    await expect(inspectArchiveTar(duplicateArchive, sessionId, [payload])).resolves.toMatchObject({
      kind: 'blocked',
    });
    await expect(
      inspectArchiveTar(wrongRootArchive, sessionId, [`${sessionId}/missing.txt`]),
    ).resolves.toMatchObject({
      kind: 'blocked',
    });
    await expect(inspectArchiveTar(wrongRootArchive, 'different-session')).resolves.toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('unsafe'),
    });
  });
});
