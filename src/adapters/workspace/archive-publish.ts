/**
 * @module workspace/archive-publish
 * @description Publishes a verified archive pair without ever destroying the
 * previously published generation.
 *
 * The archive and its checksum sidecar are two files; no filesystem operation
 * replaces both atomically. This module therefore does not claim an atomic
 * pair swap. It guarantees the property the evidence boundary needs instead:
 *
 * 1. A publish journal records the attempt and the digests of the NEXT pair
 *    before any canonical file is moved. The journal is the commit point.
 * 2. The currently published pair is moved aside (`<name>.previous`). Its bytes
 *    are never deleted on a failed publish.
 * 3. The new pair is published under the canonical names.
 * 4. The journal is removed first (commit), then the retained pair is removed
 *    best-effort. A retained pair without a journal is garbage from a completed
 *    publication and is deleted, never restored.
 *
 * Recovery (next publish, before anything is moved):
 * - No journal: remove stray `.previous` files. They can only be leftovers of a
 *   completed publication; restoring them would roll back newer evidence.
 * - Journal present: hash the canonical files. If they already equal the
 *   recorded next pair, the publish completed and only cleanup is missing —
 *   keep the published pair and drop the retained files. Otherwise restore the
 *   retained files that exist and discard a partially published new file. A
 *   crash during the retain step therefore restores the one file that was
 *   already moved instead of aborting.
 * - An unreadable journal fails closed; the directory is preserved for manual
 *   analysis instead of guessing which generation is authoritative.
 *
 * @version v3
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '../persistence.js';
import { hashBuffer, hashFile } from '../../shared/hashing.js';
import { WorkspaceError } from './types.js';

export interface ArchiveArtifactPaths {
  readonly archivePath: string;
  readonly checksumPath: string;
  readonly temporaryArchivePath: string;
  readonly temporaryChecksumPath: string;
}

/** Suffix of the retained previous generation. */
const RETAINED_SUFFIX = '.previous';

/** Journal file suffix next to the published archive. */
const JOURNAL_SUFFIX = '.publish-journal.json';

const JOURNAL_SCHEMA_VERSION = 'archive-publish-journal.v1' as const;

interface PublishJournal {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly archiveFile: string;
  readonly next: {
    readonly archiveDigest: string;
    readonly checksumDigest: string;
  };
}

function retainedPath(finalPath: string): string {
  return `${finalPath}${RETAINED_SUFFIX}`;
}

function journalPath(archivePath: string): string {
  return `${archivePath}${JOURNAL_SUFFIX}`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function digestOrNull(filePath: string): Promise<string | null> {
  try {
    return await hashFile(filePath);
  } catch {
    return null;
  }
}

/** Remove temporary inputs. Never touches a published or retained file. */
export async function removeArchiveTemporaries(paths: ArchiveArtifactPaths): Promise<void> {
  await Promise.all(
    [paths.temporaryArchivePath, paths.temporaryChecksumPath].map((filePath) =>
      fs.rm(filePath, { force: true }),
    ),
  );
}

async function readJournal(archivePath: string): Promise<PublishJournal | null> {
  let raw: string;
  try {
    raw = await fs.readFile(journalPath(archivePath), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Archive publish journal cannot be read: ${describe(error)}. Preserve the archive directory.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const journal = parsed as Partial<PublishJournal> | null;
  if (
    journal === null ||
    journal.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    typeof journal.archiveFile !== 'string' ||
    typeof journal.next?.archiveDigest !== 'string' ||
    typeof journal.next?.checksumDigest !== 'string'
  ) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      'Archive publish journal is unreadable or violates its schema. Preserve the archive ' +
        'directory and inspect the journal instead of guessing the authoritative generation.',
    );
  }
  return journal as PublishJournal;
}

async function writeJournal(archivePath: string, journal: PublishJournal): Promise<void> {
  try {
    await atomicWrite(journalPath(archivePath), `${JSON.stringify(journal, null, 2)}\n`);
  } catch (error) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Cannot write archive publish journal: ${describe(error)}`,
    );
  }
}

async function removeJournal(archivePath: string): Promise<void> {
  await fs.rm(journalPath(archivePath), { force: true });
}

/** Drop retained files; a leftover `.previous` is garbage, never evidence. */
async function removeRetained(paths: Pick<ArchiveArtifactPaths, 'archivePath' | 'checksumPath'>) {
  await Promise.all(
    [retainedPath(paths.archivePath), retainedPath(paths.checksumPath)].map((filePath) =>
      fs.rm(filePath, { force: true }),
    ),
  );
}

/**
 * Resolve an interrupted publication before a new attempt starts.
 *
 * @returns whether an interrupted attempt was resolved (rollback or cleanup).
 * @throws WorkspaceError `ARCHIVE_FAILED` when the journal is unreadable.
 */
export async function recoverInterruptedArchivePublication(
  paths: Pick<ArchiveArtifactPaths, 'archivePath' | 'checksumPath'>,
): Promise<boolean> {
  const journal = await readJournal(paths.archivePath);
  if (journal === null) {
    // A retained pair without a journal is the leftover of a COMPLETED publish:
    // the journal is removed before the retained files. Restoring it would roll
    // back newer, already published evidence.
    await removeRetained(paths);
    return false;
  }

  const [archiveDigest, checksumDigest] = await Promise.all([
    digestOrNull(paths.archivePath),
    digestOrNull(paths.checksumPath),
  ]);
  const completed =
    archiveDigest === journal.next.archiveDigest && checksumDigest === journal.next.checksumDigest;
  if (completed) {
    await removeRetained(paths);
    await removeJournal(paths.archivePath);
    return true;
  }

  const retainedArchive = retainedPath(paths.archivePath);
  const retainedChecksum = retainedPath(paths.checksumPath);
  // Restore only what was actually moved. A crash after the first retain leaves
  // the canonical counterpart untouched and still authoritative.
  if (await exists(retainedChecksum)) {
    await fs.rm(paths.checksumPath, { force: true });
    await fs.rename(retainedChecksum, paths.checksumPath);
  }
  if (await exists(retainedArchive)) {
    await fs.rm(paths.archivePath, { force: true });
    await fs.rename(retainedArchive, paths.archivePath);
  }
  await removeJournal(paths.archivePath);
  return true;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Publish the staged pair.
 *
 * @param paths - Canonical and temporary paths of the publication.
 * @param rename - Injectable rename primitive (tests inject failures).
 * @throws WorkspaceError `ARCHIVE_FAILED` after the previous generation was
 *   restored. If the restore fails the journal and retained paths are kept and
 *   named in the error, so the next attempt can still recover.
 */
export async function publishArchiveArtifacts(
  paths: ArchiveArtifactPaths,
  rename: typeof fs.rename = fs.rename,
): Promise<void> {
  await recoverInterruptedArchivePublication(paths);

  const next = {
    archiveDigest: await hashFile(paths.temporaryArchivePath),
    checksumDigest: await hashFile(paths.temporaryChecksumPath),
  };
  const journal: PublishJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    archiveFile: path.basename(paths.archivePath),
    next,
  };
  await writeJournal(paths.archivePath, journal);

  const retainedArchive = retainedPath(paths.archivePath);
  const retainedChecksum = retainedPath(paths.checksumPath);
  const [hadArchive, hadChecksum] = await Promise.all([
    exists(paths.archivePath),
    exists(paths.checksumPath),
  ]);

  // Retain the current generation before any canonical name is rewritten.
  const retained = { archive: false, checksum: false };
  try {
    if (hadChecksum) {
      await rename(paths.checksumPath, retainedChecksum);
      retained.checksum = true;
    }
    if (hadArchive) {
      await rename(paths.archivePath, retainedArchive);
      retained.archive = true;
    }
  } catch (error) {
    const rolledBack = await rollbackRetained(paths, retainedArchive, retainedChecksum, retained);
    if (rolledBack) await removeJournal(paths.archivePath);
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      rolledBack
        ? `Archive publication could not retain the previous generation: ${describe(error)}. ` +
            'The previous generation was restored; no archive was lost.'
        : `Archive publication could not retain the previous generation and the rollback failed. ` +
            `Retained evidence: ${retainedArchive}, ${retainedChecksum}. ` +
            `Journal: ${journalPath(paths.archivePath)}. Cause: ${describe(error)}`,
    );
  }

  try {
    // Checksum first: archive availability is the consumer signal, and its
    // sidecar must already be in place when the archive appears.
    await rename(paths.temporaryChecksumPath, paths.checksumPath);
    await rename(paths.temporaryArchivePath, paths.archivePath);
  } catch (error) {
    await removeArchiveTemporaries(paths);
    await fs.rm(paths.checksumPath, { force: true });
    await fs.rm(paths.archivePath, { force: true });
    const restored = await restoreRetained(retainedArchive, retainedChecksum, paths);
    if (!restored) {
      throw new WorkspaceError(
        'ARCHIVE_FAILED',
        `Archive publication failed and the previous generation could not be restored. ` +
          `Retained evidence: ${retainedArchive}, ${retainedChecksum}. ` +
          `Journal: ${journalPath(paths.archivePath)}. Cause: ${describe(error)}`,
      );
    }
    await removeJournal(paths.archivePath);
    throw error;
  }

  // Commit: once the journal is gone the new pair is authoritative and any
  // remaining `.previous` files are garbage. Removing the journal first is what
  // prevents a later recovery from rolling a published generation back.
  await removeJournal(paths.archivePath);
  await fs.rm(retainedArchive, { force: true }).catch(() => {});
  await fs.rm(retainedChecksum, { force: true }).catch(() => {});
}

/** Move back only the generations that were already retained. */
async function rollbackRetained(
  paths: Pick<ArchiveArtifactPaths, 'archivePath' | 'checksumPath'>,
  retainedArchive: string,
  retainedChecksum: string,
  retained: { readonly archive: boolean; readonly checksum: boolean },
): Promise<boolean> {
  try {
    if (retained.archive) await fs.rename(retainedArchive, paths.archivePath);
    if (retained.checksum) await fs.rename(retainedChecksum, paths.checksumPath);
    return true;
  } catch {
    return false;
  }
}

/** Restore both retained files; a partial restore keeps what is left behind. */
async function restoreRetained(
  retainedArchive: string,
  retainedChecksum: string,
  paths: Pick<ArchiveArtifactPaths, 'archivePath' | 'checksumPath'>,
): Promise<boolean> {
  try {
    if (await exists(retainedChecksum)) await fs.rename(retainedChecksum, paths.checksumPath);
    if (await exists(retainedArchive)) await fs.rename(retainedArchive, paths.archivePath);
    return true;
  } catch {
    return false;
  }
}

/** Write the SHA-256 sidecar for a published archive bundle. */
export async function writeArchiveChecksum(
  archivePath: string,
  checksumPath: string,
  archiveFileName: string,
): Promise<void> {
  try {
    await atomicWrite(
      checksumPath,
      `${hashBuffer(await fs.readFile(archivePath))}  ${archiveFileName}\n`,
    );
  } catch (error) {
    throw new WorkspaceError('ARCHIVE_FAILED', `Checksum sidecar write failed: ${describe(error)}`);
  }
}
