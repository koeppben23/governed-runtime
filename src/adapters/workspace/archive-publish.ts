/**
 * @module workspace/archive-publish
 * @description Publishes a verified archive pair without ever destroying the
 * previously published generation.
 *
 * The archive and its checksum sidecar are two files; no filesystem operation
 * replaces both atomically. This module therefore does not claim an atomic
 * pair swap. It guarantees the property the evidence boundary needs instead:
 *
 * 1. The currently published pair is moved aside (`.previous`) before any new
 *    file takes its place. Its bytes are never deleted on a failed publish.
 * 2. The new pair is published under the canonical names.
 * 3. On success the retained pair is removed.
 * 4. On failure the retained pair is restored, the partially published new
 *    files are discarded and the original error is rethrown. If the restore
 *    itself fails, the retained files are kept and their paths are named in the
 *    error — evidence is never silently lost.
 *
 * Every crash point leaves at least one complete generation on disk. A later
 * publish calls {@link recoverInterruptedArchivePublication} first, which
 * deterministically restores the retained pair, so an interrupted publication
 * converges back to the last published generation instead of a mixed pair.
 *
 * @version v2
 */

import * as fs from 'node:fs/promises';
import { atomicWrite } from '../persistence.js';
import { hashBuffer } from '../../shared/hashing.js';
import { WorkspaceError } from './types.js';

export interface ArchiveArtifactPaths {
  readonly archivePath: string;
  readonly checksumPath: string;
  readonly temporaryArchivePath: string;
  readonly temporaryChecksumPath: string;
}

/** Suffix of the retained previous generation. */
const RETAINED_SUFFIX = '.previous';

function retainedPath(finalPath: string): string {
  return `${finalPath}${RETAINED_SUFFIX}`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
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

/**
 * Restore a retained previous generation left behind by an interrupted publish.
 *
 * The rule is deliberately generation-wide: if either retained file exists, the
 * interrupted attempt is rolled back as a pair. Any file the interrupted attempt
 * published under the canonical name is discarded so the restored archive and
 * its sidecar always describe the same publication.
 *
 * @returns whether a recovery was performed.
 */
export async function recoverInterruptedArchivePublication(
  paths: Pick<ArchiveArtifactPaths, 'archivePath' | 'checksumPath'>,
): Promise<boolean> {
  const retainedArchive = retainedPath(paths.archivePath);
  const retainedChecksum = retainedPath(paths.checksumPath);
  const [hasArchive, hasChecksum] = await Promise.all([
    exists(retainedArchive),
    exists(retainedChecksum),
  ]);
  if (!hasArchive && !hasChecksum) return false;
  if (!hasArchive || !hasChecksum) {
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      'Interrupted archive publication left an incomplete retained generation ' +
        `(${hasArchive ? retainedArchive : retainedChecksum}). Preserve the archive directory and ` +
        're-run the archive command after restoring the missing retained file.',
    );
  }
  await Promise.all([
    fs.rm(paths.archivePath, { force: true }),
    fs.rm(paths.checksumPath, { force: true }),
  ]);
  await fs.rename(retainedArchive, paths.archivePath);
  await fs.rename(retainedChecksum, paths.checksumPath);
  return true;
}

/**
 * Publish the staged pair.
 *
 * @param paths - Canonical and temporary paths of the publication.
 * @param rename - Injectable rename primitive (tests inject failures).
 * @returns nothing; the caller reads the published binding afterwards.
 * @throws WorkspaceError `ARCHIVE_FAILED` after the previous generation was
 *   restored. If the restore fails, the retained paths are named in the error.
 */
export async function publishArchiveArtifacts(
  paths: ArchiveArtifactPaths,
  rename: typeof fs.rename = fs.rename,
): Promise<void> {
  await recoverInterruptedArchivePublication(paths);

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
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      rolledBack
        ? `Archive publication could not retain the previous generation: ${describe(error)}. ` +
            'The previous generation was restored; no archive was lost.'
        : `Archive publication could not retain the previous generation and the rollback failed. ` +
            `Retained evidence: ${retainedArchive}, ${retainedChecksum}. Cause: ${describe(error)}`,
    );
  }

  try {
    // Checksum first: archive availability is the consumer signal, and its
    // sidecar must already be in place when the archive appears.
    await rename(paths.temporaryChecksumPath, paths.checksumPath);
    await rename(paths.temporaryArchivePath, paths.archivePath);
  } catch (error) {
    await removeArchiveTemporaries(paths);
    await fs.rm(paths.archivePath, { force: true });
    await fs.rm(paths.checksumPath, { force: true });
    const restored = await restoreRetained(retainedArchive, retainedChecksum, paths);
    if (!restored) {
      throw new WorkspaceError(
        'ARCHIVE_FAILED',
        `Archive publication failed and the previous generation could not be restored. ` +
          `Retained evidence: ${retainedArchive}, ${retainedChecksum}. Cause: ${describe(error)}`,
      );
    }
    throw error;
  }

  // The new pair is published; the retained generation is now redundant.
  // Cleanup failure only leaves garbage and must not fail the publication.
  await fs.rm(retainedArchive, { force: true }).catch(() => {});
  await fs.rm(retainedChecksum, { force: true }).catch(() => {});
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    throw new WorkspaceError(
      'ARCHIVE_FAILED',
      `Checksum sidecar write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
