import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  publishArchiveArtifacts,
  recoverInterruptedArchivePublication,
  removeArchiveTemporaries,
} from './archive-publish.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface Fixture {
  readonly paths: {
    archivePath: string;
    checksumPath: string;
    temporaryArchivePath: string;
    temporaryChecksumPath: string;
  };
}

async function makeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-publish-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return {
    paths: {
      archivePath: path.join(root, 'session.tar.gz'),
      checksumPath: path.join(root, 'session.tar.gz.sha256'),
      temporaryArchivePath: path.join(root, 'session.tar.gz.archive.tmp'),
      temporaryChecksumPath: path.join(root, 'session.tar.gz.sha256.checksum.tmp'),
    },
  };
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('archive publication', () => {
  it('restores the previously published pair when publication fails', async () => {
    const { paths } = await makeFixture();
    await Promise.all([
      fs.writeFile(paths.archivePath, 'stale archive', 'utf8'),
      fs.writeFile(paths.checksumPath, 'stale checksum', 'utf8'),
      fs.writeFile(paths.temporaryArchivePath, 'new archive', 'utf8'),
      fs.writeFile(paths.temporaryChecksumPath, 'new checksum', 'utf8'),
    ]);

    await expect(
      publishArchiveArtifacts(paths, async (source, destination) => {
        if (destination === paths.checksumPath)
          throw new Error('injected checksum publish failure');
        await fs.rename(source, destination);
      }),
    ).rejects.toThrow('injected checksum publish failure');

    // The attested generation survives byte for byte.
    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('stale archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('stale checksum');
    await expectMissing(paths.temporaryArchivePath);
    await expectMissing(paths.temporaryChecksumPath);
    await expectMissing(`${paths.archivePath}.previous`);
    await expectMissing(`${paths.checksumPath}.previous`);
  });

  it('restores the previous pair when the archive rename fails after the sidecar', async () => {
    const { paths } = await makeFixture();
    await Promise.all([
      fs.writeFile(paths.archivePath, 'stale archive', 'utf8'),
      fs.writeFile(paths.checksumPath, 'stale checksum', 'utf8'),
      fs.writeFile(paths.temporaryArchivePath, 'new archive', 'utf8'),
      fs.writeFile(paths.temporaryChecksumPath, 'new checksum', 'utf8'),
    ]);

    await expect(
      publishArchiveArtifacts(paths, async (source, destination) => {
        if (destination === paths.archivePath) throw new Error('injected archive publish failure');
        await fs.rename(source, destination);
      }),
    ).rejects.toThrow('injected archive publish failure');

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('stale archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('stale checksum');
    await expectMissing(`${paths.archivePath}.previous`);
    await expectMissing(`${paths.checksumPath}.previous`);
  });

  it('keeps the first publication when the archive directory was empty', async () => {
    const { paths } = await makeFixture();
    await Promise.all([
      fs.writeFile(paths.temporaryArchivePath, 'archive', 'utf8'),
      fs.writeFile(paths.temporaryChecksumPath, 'checksum', 'utf8'),
    ]);

    await publishArchiveArtifacts(paths);

    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('checksum');
    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('archive');
    await expectMissing(`${paths.archivePath}.previous`);
    await expectMissing(`${paths.checksumPath}.previous`);
  });

  it('publishes the checksum before making the archive visible', async () => {
    const { paths } = await makeFixture();
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

  it('recovers a generation retained by an interrupted publication', async () => {
    const { paths } = await makeFixture();
    // Crash after both files were retained but before the new pair was published.
    await Promise.all([
      fs.writeFile(`${paths.archivePath}.previous`, 'retained archive', 'utf8'),
      fs.writeFile(`${paths.checksumPath}.previous`, 'retained checksum', 'utf8'),
    ]);

    await expect(recoverInterruptedArchivePublication(paths)).resolves.toBe(true);

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('retained archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('retained checksum');
    await expectMissing(`${paths.archivePath}.previous`);
    await expectMissing(`${paths.checksumPath}.previous`);
  });

  it('discards a partially published file when recovering', async () => {
    const { paths } = await makeFixture();
    await Promise.all([
      fs.writeFile(`${paths.archivePath}.previous`, 'retained archive', 'utf8'),
      fs.writeFile(`${paths.checksumPath}.previous`, 'retained checksum', 'utf8'),
      // Crash between the two publish renames: the new sidecar is visible.
      fs.writeFile(paths.checksumPath, 'half-published checksum', 'utf8'),
    ]);

    await recoverInterruptedArchivePublication(paths);

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('retained archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('retained checksum');
  });

  it('fails closed when an interrupted publication left only one retained file', async () => {
    const { paths } = await makeFixture();
    await fs.writeFile(`${paths.archivePath}.previous`, 'retained archive', 'utf8');

    await expect(recoverInterruptedArchivePublication(paths)).rejects.toMatchObject({
      code: 'ARCHIVE_FAILED',
      message: expect.stringContaining('incomplete retained generation'),
    });
  });

  it('removes only temporary inputs', async () => {
    const { paths } = await makeFixture();
    await Promise.all([
      fs.writeFile(paths.archivePath, 'published archive', 'utf8'),
      fs.writeFile(paths.checksumPath, 'published checksum', 'utf8'),
      fs.writeFile(paths.temporaryArchivePath, 'temp archive', 'utf8'),
      fs.writeFile(paths.temporaryChecksumPath, 'temp checksum', 'utf8'),
    ]);

    await removeArchiveTemporaries(paths);

    await expectMissing(paths.temporaryArchivePath);
    await expectMissing(paths.temporaryChecksumPath);
    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('published archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('published checksum');
  });
});
