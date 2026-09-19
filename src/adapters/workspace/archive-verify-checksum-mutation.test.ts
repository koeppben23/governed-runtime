/**
 * @module adapters/workspace/archive-verify-checksum-mutation.test
 * @description Mutation-focused contract tests for the archive checksum
 * verification stage.
 *
 * Covers the two fail-closed read paths (sidecar unreadable, archive snapshot
 * unreadable) with distinct ENOENT vs non-ENOENT diagnostics, and pins the
 * digest-mismatch message to truncated 12-character digests.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashBuffer } from '../../shared/hashing.js';
import type { ArchiveFinding } from '../../archive/types.js';
import { verifyArchiveChecksum } from './archive-verify-checksum.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-checksum-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

describe('verifyArchiveChecksum read-failure diagnostics', () => {
  it('accepts a sidecar digest that matches the archive bytes', async () => {
    const root = await createRoot();
    const archivePath = path.join(root, 'archive.tar.gz');
    const sidecarPath = `${archivePath}.sha256`;
    const archiveBytes = Buffer.from('archive bytes');
    await fs.writeFile(archivePath, archiveBytes);
    await fs.writeFile(sidecarPath, `${hashBuffer(archiveBytes)}  archive.tar.gz\n`, 'utf8');

    const findings: ArchiveFinding[] = [];
    await verifyArchiveChecksum(archivePath, sidecarPath, false, findings);

    expect(findings).toEqual([]);
  });

  it('reports a missing archive tarball for an ENOENT read failure', async () => {
    const root = await createRoot();
    const archivePath = path.join(root, 'archive.tar.gz');
    const sidecarPath = `${archivePath}.sha256`;
    await fs.writeFile(sidecarPath, `${'a'.repeat(64)}  archive.tar.gz\n`, 'utf8');

    const findings: ArchiveFinding[] = [];
    await verifyArchiveChecksum(archivePath, sidecarPath, false, findings);

    expect(findings).toEqual([
      {
        code: 'archive_checksum_mismatch',
        severity: 'error',
        message: expect.stringMatching(
          /^Archive tarball is missing; archive checksum could not be verified: ENOENT/,
        ),
      },
    ]);
  });

  it('reports an unreadable archive tarball for a non-ENOENT read failure', async () => {
    const root = await createRoot();
    const archivePath = path.join(root, 'archive.tar.gz');
    await fs.mkdir(archivePath);
    const sidecarPath = `${archivePath}.sha256`;
    await fs.writeFile(sidecarPath, `${'a'.repeat(64)}  archive.tar.gz\n`, 'utf8');

    const findings: ArchiveFinding[] = [];
    await verifyArchiveChecksum(archivePath, sidecarPath, false, findings);

    expect(findings).toEqual([
      {
        code: 'archive_checksum_mismatch',
        severity: 'error',
        message: expect.stringMatching(
          /^Archive tarball is unreadable; archive checksum could not be verified: EISDIR/,
        ),
      },
    ]);
  });

  it('reports an unreadable sidecar when the sidecar path exists but cannot be read', async () => {
    const root = await createRoot();
    const archivePath = path.join(root, 'archive.tar.gz');
    await fs.writeFile(archivePath, 'archive bytes');
    const sidecarPath = `${archivePath}.sha256`;
    await fs.mkdir(sidecarPath);

    const findings: ArchiveFinding[] = [];
    await verifyArchiveChecksum(archivePath, sidecarPath, false, findings);

    expect(findings).toEqual([
      {
        code: 'archive_checksum_mismatch',
        severity: 'error',
        message: expect.stringMatching(
          /^Archive checksum sidecar is unreadable; archive checksum could not be verified: EISDIR/,
        ),
      },
    ]);
  });

  it('reports both digests truncated to 12 characters in the mismatch message', async () => {
    const root = await createRoot();
    const archivePath = path.join(root, 'archive.tar.gz');
    const sidecarPath = `${archivePath}.sha256`;
    const archiveBytes = Buffer.from('archive bytes');
    await fs.writeFile(archivePath, archiveBytes);
    const expectedHash = 'a'.repeat(64);
    await fs.writeFile(sidecarPath, `${expectedHash}  archive.tar.gz\n`, 'utf8');

    const findings: ArchiveFinding[] = [];
    await verifyArchiveChecksum(archivePath, sidecarPath, false, findings);

    const actualHash = hashBuffer(archiveBytes);
    expect(findings).toEqual([
      {
        code: 'archive_checksum_mismatch',
        severity: 'error',
        message: `Archive checksum mismatch: sidecar says ${expectedHash.slice(0, 12)}..., actual is ${actualHash.slice(0, 12)}...`,
      },
    ]);
  });
});
