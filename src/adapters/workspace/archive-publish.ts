/**
 * @module workspace/archive-publish
 * @description Atomically publishes verified archive artifacts or removes them.
 */

import * as fs from 'node:fs/promises';

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
    await rename(paths.temporaryArchivePath, paths.archivePath);
    await rename(paths.temporaryChecksumPath, paths.checksumPath);
  } catch (error) {
    await removeArchiveArtifacts(paths);
    throw error;
  }
}
