import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  publishArchiveArtifacts,
  recoverInterruptedArchivePublication,
  removeArchiveTemporaries,
  writeArchiveChecksum,
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

  it('writes the checksum sidecar for the archive bytes', async () => {
    const paths = await makeFixture();
    await fs.writeFile(paths.archivePath, 'archive bytes', 'utf8');

    await writeArchiveChecksum(paths.archivePath, paths.checksumPath, 'session.tar.gz');

    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe(
      `${hashText('archive bytes')}  session.tar.gz\n`,
    );
  });

  it('fails closed when the checksum sidecar cannot read its archive', async () => {
    const paths = await makeFixture();

    await expect(
      writeArchiveChecksum(paths.archivePath, paths.checksumPath, 'session.tar.gz'),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });
  });

  const validJournal = {
    schemaVersion: 'archive-publish-journal.v1',
    archiveFile: 'session.tar.gz',
    next: { archiveDigest: 'archive', checksumDigest: 'checksum' },
  };

  it.each([
    ['an unknown schema version', { ...validJournal, schemaVersion: 'archive-publish-journal.v2' }],
    ['a non-string archiveFile', { ...validJournal, archiveFile: 7 }],
    ['a missing next block', { ...validJournal, next: undefined }],
    [
      'a non-string archive digest',
      { ...validJournal, next: { ...validJournal.next, archiveDigest: 1 } },
    ],
    [
      'a non-string checksum digest',
      { ...validJournal, next: { ...validJournal.next, checksumDigest: 1 } },
    ],
  ])('fails closed on a journal with %s', async (_label, payload) => {
    const paths = await makeFixture();
    await seedPublished(paths, 'archive', 'checksum');
    await fs.writeFile(journalPath(paths), JSON.stringify(payload), 'utf8');

    await expect(recoverInterruptedArchivePublication(paths)).rejects.toMatchObject({
      code: 'ARCHIVE_FAILED',
    });
  });

  it('fails closed when the journal path cannot be read for a non-ENOENT reason', async () => {
    const paths = await makeFixture();
    await seedPublished(paths, 'archive', 'checksum');
    await fs.mkdir(journalPath(paths));

    await expect(recoverInterruptedArchivePublication(paths)).rejects.toMatchObject({
      code: 'ARCHIVE_FAILED',
    });
  });

  it.each([
    ['a null journal', 'null'],
    ['a JSON array journal', '[]'],
    ['a JSON string journal', '"journal"'],
  ])('fails closed on %s', async (_label, raw) => {
    const paths = await makeFixture();
    await seedPublished(paths, 'archive', 'checksum');
    await fs.writeFile(journalPath(paths), raw, 'utf8');

    await expect(recoverInterruptedArchivePublication(paths)).rejects.toMatchObject({
      code: 'ARCHIVE_FAILED',
    });
  });

  it('fails closed when the checksum sidecar cannot be written', async () => {
    const paths = await makeFixture();
    await fs.writeFile(paths.archivePath, 'archive bytes', 'utf8');

    await expect(
      writeArchiveChecksum(
        paths.archivePath,
        path.join(path.dirname(paths.checksumPath), 'missing', 'sidecar.sha256'),
        'session.tar.gz',
      ),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });
  });

  it('rolls back when only the archive digest matches the journal', async () => {
    const paths = await makeFixture();
    await seedPublished(paths, 'new archive', 'other checksum');
    await fs.writeFile(`${paths.archivePath}.previous`, 'old archive', 'utf8');
    await fs.writeFile(`${paths.checksumPath}.previous`, 'old checksum', 'utf8');
    await writeJournal(paths, { archive: 'new archive', checksum: 'new checksum' });

    await expect(recoverInterruptedArchivePublication(paths)).resolves.toBe(true);

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('old archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('old checksum');
  });

  it('rolls back when only the checksum digest matches the journal', async () => {
    const paths = await makeFixture();
    await seedPublished(paths, 'other archive', 'new checksum');
    await fs.writeFile(`${paths.archivePath}.previous`, 'old archive', 'utf8');
    await fs.writeFile(`${paths.checksumPath}.previous`, 'old checksum', 'utf8');
    await writeJournal(paths, { archive: 'new archive', checksum: 'new checksum' });

    await expect(recoverInterruptedArchivePublication(paths)).resolves.toBe(true);

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('old archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('old checksum');
  });

  it('publishes over an archive-only generation without a checksum', async () => {
    const paths = await makeFixture();
    await fs.writeFile(paths.archivePath, 'old archive', 'utf8');
    await seedStaged(paths, 'new archive', 'new checksum');

    await publishArchiveArtifacts(paths);

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('new archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('new checksum');
    await expectMissing(`${paths.archivePath}.previous`);
    await expectMissing(`${paths.checksumPath}.previous`);
  });

  it('publishes over a checksum-only generation without an archive', async () => {
    const paths = await makeFixture();
    await fs.writeFile(paths.checksumPath, 'old checksum', 'utf8');
    await seedStaged(paths, 'new archive', 'new checksum');

    await publishArchiveArtifacts(paths);

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('new archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('new checksum');
    await expectMissing(`${paths.archivePath}.previous`);
    await expectMissing(`${paths.checksumPath}.previous`);
  });

  it('restores a retained archive when the checksum was never retained', async () => {
    const paths = await makeFixture();
    await fs.writeFile(paths.archivePath, 'current archive', 'utf8');
    await fs.writeFile(`${paths.archivePath}.previous`, 'retained archive', 'utf8');
    await fs.writeFile(paths.checksumPath, 'current checksum', 'utf8');
    await writeJournal(paths, { archive: 'new archive', checksum: 'new checksum' });

    await expect(recoverInterruptedArchivePublication(paths)).resolves.toBe(true);

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('retained archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('current checksum');
    await expectMissing(`${paths.archivePath}.previous`);
  });

  it('restores a retained checksum when the archive was never retained', async () => {
    const paths = await makeFixture();
    await fs.writeFile(paths.archivePath, 'current archive', 'utf8');
    await fs.writeFile(paths.checksumPath, 'current checksum', 'utf8');
    await fs.writeFile(`${paths.checksumPath}.previous`, 'retained checksum', 'utf8');
    await writeJournal(paths, { archive: 'new archive', checksum: 'new checksum' });

    await expect(recoverInterruptedArchivePublication(paths)).resolves.toBe(true);

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('current archive');
    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('retained checksum');
    await expectMissing(`${paths.checksumPath}.previous`);
  });

  it('rolls back the retained checksum when the archive retain fails', async () => {
    const paths = await makeFixture();
    await seedPublished(paths, 'old archive', 'old checksum');
    await seedStaged(paths, 'new archive', 'new checksum');

    await expect(
      publishArchiveArtifacts(paths, async (source, destination) => {
        if (destination === `${paths.archivePath}.previous`) throw new Error('retain failure');
        await fs.rename(source, destination);
      }),
    ).rejects.toThrow('previous generation was restored');

    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('old checksum');
    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('old archive');
  });

  it('keeps the canonical checksum when its own retain fails', async () => {
    const paths = await makeFixture();
    await fs.writeFile(paths.checksumPath, 'old checksum', 'utf8');
    await seedStaged(paths, 'new archive', 'new checksum');

    await expect(
      publishArchiveArtifacts(paths, async (source, destination) => {
        if (destination === `${paths.checksumPath}.previous`) throw new Error('retain failure');
        await fs.rename(source, destination);
      }),
    ).rejects.toThrow('previous generation was restored');

    await expect(fs.readFile(paths.checksumPath, 'utf8')).resolves.toBe('old checksum');
  });

  it('keeps the canonical archive when its own retain fails', async () => {
    const paths = await makeFixture();
    await fs.writeFile(paths.archivePath, 'old archive', 'utf8');
    await seedStaged(paths, 'new archive', 'new checksum');

    await expect(
      publishArchiveArtifacts(paths, async (source, destination) => {
        if (destination === `${paths.archivePath}.previous`) throw new Error('retain failure');
        await fs.rename(source, destination);
      }),
    ).rejects.toThrow('previous generation was restored');

    await expect(fs.readFile(paths.archivePath, 'utf8')).resolves.toBe('old archive');
  });

  it.skipIf(process.platform === 'win32')(
    'fails closed when the publish journal cannot be written',
    async () => {
      const paths = await makeFixture();
      await seedStaged(paths, 'new archive', 'new checksum');
      const root = path.dirname(paths.archivePath);
      await fs.chmod(root, 0o500);
      try {
        await expect(publishArchiveArtifacts(paths)).rejects.toThrow(
          'Cannot write archive publish journal',
        );
      } finally {
        await fs.chmod(root, 0o700);
      }
    },
  );

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
