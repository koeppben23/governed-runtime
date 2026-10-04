import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { publishArchiveArtifacts } from './archive-publish.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

it('removes final and temporary artifacts when checksum publication fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-publish-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    archivePath: path.join(root, 'session.tar.gz'),
    checksumPath: path.join(root, 'session.tar.gz.sha256'),
    temporaryArchivePath: path.join(root, 'session.tar.gz.archive.tmp'),
    temporaryChecksumPath: path.join(root, 'session.tar.gz.sha256.checksum.tmp'),
  };
  await Promise.all([
    fs.writeFile(paths.archivePath, 'stale archive', 'utf8'),
    fs.writeFile(paths.checksumPath, 'stale checksum', 'utf8'),
    fs.writeFile(paths.temporaryArchivePath, 'new archive', 'utf8'),
    fs.writeFile(paths.temporaryChecksumPath, 'new checksum', 'utf8'),
  ]);

  await expect(
    publishArchiveArtifacts(paths, async (source, destination) => {
      if (destination === paths.checksumPath) throw new Error('injected checksum publish failure');
      await fs.rename(source, destination);
    }),
  ).rejects.toThrow('injected checksum publish failure');

  await expect(fs.access(paths.archivePath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.access(paths.checksumPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.access(paths.temporaryArchivePath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.access(paths.temporaryChecksumPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('publishes the checksum before making the archive visible', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-publish-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    archivePath: path.join(root, 'session.tar.gz'),
    checksumPath: path.join(root, 'session.tar.gz.sha256'),
    temporaryArchivePath: path.join(root, 'session.tar.gz.archive.tmp'),
    temporaryChecksumPath: path.join(root, 'session.tar.gz.sha256.checksum.tmp'),
  };
  await Promise.all([
    fs.writeFile(paths.temporaryArchivePath, 'archive', 'utf8'),
    fs.writeFile(paths.temporaryChecksumPath, 'checksum', 'utf8'),
  ]);
  const destinations: string[] = [];

  await publishArchiveArtifacts(paths, async (source, destination) => {
    destinations.push(String(destination));
    await fs.rename(source, destination);
  });

  expect(destinations).toEqual([paths.checksumPath, paths.archivePath]);
  await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('checksum');
  await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('archive');
});
