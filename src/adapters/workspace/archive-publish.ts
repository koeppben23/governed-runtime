/**
 * @module workspace/archive-publish
 * @description Publishes verified archive artifacts or removes them on failure.
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

export async function removeArchiveArtifacts(paths: ArchiveArtifactPaths): Promise<void> {
  await Promise.all(
    [
      paths.archivePath,
      paths.checksumPath,
      paths.temporaryArchivePath,
      paths.temporaryChecksumPath,
    ].map((filePath) => fs.rm(filePath, { force: true })),
  );
}

export async function publishArchiveArtifacts(
  paths: ArchiveArtifactPaths,
  rename: typeof fs.rename = fs.rename,
): Promise<void> {
  try {
    await rename(paths.temporaryChecksumPath, paths.checksumPath);
    // Archive availability is the consumer signal; its checksum must exist first.
    await rename(paths.temporaryArchivePath, paths.archivePath);
  } catch (error) {
    await removeArchiveArtifacts(paths);
    throw error;
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
