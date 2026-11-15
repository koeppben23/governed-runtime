/**
 * @module persistence-audit-clone
 * @description Same-directory CoW clone + durable atomic audit record publish.
 *
 * Never mutates the committed JSONL inode. CoW reflinks only change how the
 * next complete snapshot is prepared; publication stays temp -> fsync ->
 * atomic rename -> parent directory fsync. An unsupported clone uses the
 * existing durable full-rewrite implementation.
 */
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  durableAtomicWrite,
  renameWithRetry,
  syncDirectory,
  PersistenceError,
} from './persistence.js';

const CLONE_FLAGS = constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE;

function cloneUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return (
    code === 'ENOTSUP' ||
    code === 'EOPNOTSUPP' ||
    code === 'EINVAL' ||
    code === 'ENOSYS' ||
    code === 'EXDEV'
  );
}

async function unlinkTemp(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Best effort, as for the existing canonical durable writer.
  }
}

/**
 * Publish a single complete next-generation audit snapshot.
 *
 * The caller holds the audit write lock and has verified the prior chain.
 * Neither the existing inode nor its bytes are ever changed before rename.
 */
export async function durableAtomicCloneAppend(
  filePath: string,
  appendedLine: string,
  fallbackContent: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);

  try {
    await fs.copyFile(filePath, tempPath, CLONE_FLAGS);
  } catch (error) {
    await unlinkTemp(tempPath);
    if (cloneUnsupported(error)) {
      await durableAtomicWrite(filePath, fallbackContent);
      return;
    }
    throw new PersistenceError(
      'WRITE_FAILED',
      `Audit reflink clone failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    // Preserve the canonical 0600 temp permissions even when the legacy
    // source file had broader permissions.
    await fs.chmod(tempPath, 0o600);
    const handle = await fs.open(tempPath, 'a', 0o600);
    try {
      await handle.writeFile(appendedLine, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tempPath, filePath);
    await syncDirectory(dir);
  } catch (error) {
    await unlinkTemp(tempPath);
    throw new PersistenceError(
      'WRITE_FAILED',
      `Durable audit clone-append failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
