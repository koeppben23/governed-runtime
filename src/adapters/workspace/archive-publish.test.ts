import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  publishArchiveArtifacts,
  recoverInterruptedArchivePublication,
  removeArchiveTemporaries,
} from './archive-publish.js';
import { hashText } from '../../shared/hashing.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface Paths {
  archivePath: string;
  checksumPath: string;
  temporaryArchivePath: string;
  temporaryChecksumPath: string;
}

async function makeFixture(): Promise<Paths> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-publish-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return {
    archivePath: path.join(root, 'session.tar.gz'),
    checksumPath: path.join(root, 'session.tar.gz.sha256'),
    temporaryArchivePath: path.join(root, 'session.tar.gz.archive.tmp'),
    temporaryChecksumPath: path.join(root, 'session.tar.gz.sha256.checksum.tmp'),
  };
}

const journalPath = (paths: Paths): string => `${paths.archivePath}.publish-journal.json`;

async function writeJournal(
  paths: Paths,
  next: { archive: string; checksum: string },
): Promise<void> {
  await fs.writeFile(
    journalPath(paths),
    `${JSON.stringify(
      {
        schemaVersion: 'archive-publish-journal.v1',
        archiveFile: path.basename(paths.archivePath),
        next: { archiveDigest: hashText(next.archive), checksumDigest: hashText(next.checksum) },
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function seedPublished(paths: Paths, archive: string, checksum: string): Promise<void> {
  await Promise.all([
    fs.writeFile(paths.archivePath, archive, 'utf8'),
    fs.writeFile(paths.checksumPath, checksum, 'utf8'),
  ]);
}

async function seedStaged(paths: Paths, archive: string, checksum: string): Promise<void> {
  await Promise.all([
    fs.writeFile(paths.temporaryArchivePath, archive, 'utf8'),
    fs.writeFile(paths.temporaryChecksumPath, checksum, 'utf8'),
  ]);
}

describe('archive publication', () => {
  it('restores the previously published pair when the checksum rename fails', async () => {
    const paths = await makeFixture();
    await seedPublished(paths, 'stale archive', 'stale checksum');
    await seedStaged(paths, 'new archive', 'new checksum');

    await expect(
      publishArchiveArtifacts(paths, async (source, destination) => {
        if (destination === paths.checksumPath) throw new Error('injected checksum failure');
        await fs.rename(source, destination);
      }),
    ).rejects.toThrow('injected checksum failure');

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('stale archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('stale checksum');
    await expectMissing(paths.temporaryArchivePath);
    await expectMissing(paths.temporaryChecksumPath);
    await expectMissing(`${paths.archivePath}.previous`);
    await expectMissing(`${paths.checksumPath}.previous`);
    await expectMissing(journalPath(paths));
  });

  it('restores the previous pair when the archive rename fails after the sidecar', async () => {
    const paths = await makeFixture();
    await seedPublished(paths, 'stale archive', 'stale checksum');
    await seedStaged(paths, 'new archive', 'new checksum');

    await expect(
      publishArchiveArtifacts(paths, async (source, destination) => {
        if (destination === paths.archivePath) throw new Error('injected archive failure');
        await fs.rename(source, destination);
      }),
    ).rejects.toThrow('injected archive failure');

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('stale archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('stale checksum');
    await expectMissing(`${paths.archivePath}.previous`);
    await expectMissing(`${paths.checksumPath}.previous`);
    await expectMissing(journalPath(paths));
  });

  it('publishes the first generation and leaves no journal or retained pair', async () => {
    const paths = await makeFixture();
    await seedStaged(paths, 'archive', 'checksum');

    await publishArchiveArtifacts(paths);

    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('checksum');
    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('archive');
    await expectMissing(`${paths.archivePath}.previous`);
    await expectMissing(`${paths.checksumPath}.previous`);
    await expectMissing(journalPath(paths));
  });

  it('publishes the checksum before making the archive visible', async () => {
    const paths = await makeFixture();
    await seedStaged(paths, 'archive', 'checksum');
    const destinations: string[] = [];

    await publishArchiveArtifacts(paths, async (source, destination) => {
      destinations.push(String(destination));
      await fs.rename(source, destination);
    });

    expect(destinations).toEqual([paths.checksumPath, paths.archivePath]);
  });

  it('never rolls a published generation back when only the cleanup was interrupted', async () => {
    const paths = await makeFixture();
    // The new pair is published; the crash happened before the journal was
    // removed, so both retained files still exist.
    await seedPublished(paths, 'new archive', 'new checksum');
    await fs.writeFile(`${paths.archivePath}.previous`, 'old archive', 'utf8');
    await fs.writeFile(`${paths.checksumPath}.previous`, 'old checksum', 'utf8');
    await writeJournal(paths, { archive: 'new archive', checksum: 'new checksum' });

    await expect(recoverInterruptedArchivePublication(paths)).resolves.toBe(true);

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('new archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('new checksum');
    await expectMissing(`${paths.archivePath}.previous`);
    await expectMissing(`${paths.checksumPath}.previous`);
    await expectMissing(journalPath(paths));
  });

  it('restores the one retained file after a crash during the retain step', async () => {
    const paths = await makeFixture();
    // Crash after the checksum was retained, before the archive was retained:
    // the canonical archive is still the old, authoritative file.
    await fs.writeFile(paths.archivePath, 'old archive', 'utf8');
    await fs.writeFile(`${paths.checksumPath}.previous`, 'old checksum', 'utf8');
    await writeJournal(paths, { archive: 'new archive', checksum: 'new checksum' });

    await expect(recoverInterruptedArchivePublication(paths)).resolves.toBe(true);

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('old archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('old checksum');
    await expectMissing(`${paths.archivePath}.previous`);
    await expectMissing(`${paths.checksumPath}.previous`);
    await expectMissing(journalPath(paths));
  });

  it('discards a partially published new sidecar when rolling back', async () => {
    const paths = await makeFixture();
    await fs.writeFile(paths.archivePath, '');
    await fs.writeFile(paths.checksumPath, 'half-published checksum', 'utf8');
    await fs.writeFile(`${paths.archivePath}.previous`, 'old archive', 'utf8');
    await fs.writeFile(`${paths.checksumPath}.previous`, 'old checksum', 'utf8');
    await writeJournal(paths, { archive: 'new archive', checksum: 'new checksum' });

    await recoverInterruptedArchivePublication(paths);

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('old archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('old checksum');
    await expectMissing(journalPath(paths));
  });

  it('treats a retained pair without a journal as leftover, never as evidence', async () => {
    const paths = await makeFixture();
    await seedPublished(paths, 'published archive', 'published checksum');
    await fs.writeFile(`${paths.archivePath}.previous`, 'older archive', 'utf8');
    await fs.writeFile(`${paths.checksumPath}.previous`, 'older checksum', 'utf8');

    await expect(recoverInterruptedArchivePublication(paths)).resolves.toBe(false);

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('published archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('published checksum');
    await expectMissing(`${paths.archivePath}.previous`);
    await expectMissing(`${paths.checksumPath}.previous`);
  });

  it('fails closed on an unreadable publish journal', async () => {
    const paths = await makeFixture();
    await seedPublished(paths, 'archive', 'checksum');
    await fs.writeFile(journalPath(paths), 'not json', 'utf8');

    await expect(recoverInterruptedArchivePublication(paths)).rejects.toMatchObject({
      code: 'ARCHIVE_FAILED',
      message: expect.stringContaining('journal'),
    });
  });

  it('removes only temporary inputs', async () => {
    const paths = await makeFixture();
    await seedPublished(paths, 'published archive', 'published checksum');
    await seedStaged(paths, 'temp archive', 'temp checksum');

    await removeArchiveTemporaries(paths);

    await expectMissing(paths.temporaryArchivePath);
    await expectMissing(paths.temporaryChecksumPath);
    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('published archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('published checksum');
  });
});
