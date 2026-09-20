/**
 * @module cli/install-helpers-rollback
 * @description Package-manager detection and pre-install snapshot/rollback
 * helpers for the FlowGuard CLI installer.
 *
 * Split from install-helpers.ts following the file-size budget; behavior is
 * unchanged.
 *
 * @version v1
 */

import { execSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CliInstallError } from './errors.js';
import type { FileOp } from './install-types.js';

// ─── Rollback utilities ───────────────────────────────────────────────────────

/** Detect available package manager. Prefers bun (OpenCode runtime), falls back to npm. */
export function detectPackageManager(): 'bun' | 'npm' | null {
  const opts = { stdio: 'ignore' as const, timeout: 5_000 };
  try {
    execSync('bun --version', opts);
    return 'bun';
  } catch {
    // bun not available
  }
  try {
    execSync('npm --version', opts);
    return 'npm';
  } catch {
    // npm not available
  }
  return null;
}

/** Pre-install snapshot for transactional rollback. */
export interface RollbackEntry {
  path: string;
  existed: boolean;
  expectedKind: 'file' | 'directory';
  originalContent?: Buffer;
  sequence: number;
}

/**
 * Snapshot a file path before any modification.
 * Reads original content as Buffer so binary artifacts are preserved exactly.
 * Rejects symlinks and enforces expected type coherence.
 */
export async function snapshotForRollback(
  filePath: string,
  expectedKind: 'file' | 'directory',
): Promise<RollbackEntry> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    return await snapshotFromHandle(handle, filePath, expectedKind);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return { path: filePath, existed: false, expectedKind, sequence: 0 };
    }
    if (err instanceof Error && 'code' in err && err.code === 'ELOOP') {
      throw new CliInstallError(
        'ROLLBACK_SNAPSHOT_SYMLINK',
        `Refusing to snapshot symlink: ${filePath}`,
      );
    }
    throw err;
  } finally {
    await handle?.close();
  }
}

async function snapshotFromHandle(
  handle: FileHandle,
  filePath: string,
  expectedKind: 'file' | 'directory',
): Promise<RollbackEntry> {
  const stat = await handle.stat();

  if (stat.isSymbolicLink()) {
    throw new CliInstallError(
      'ROLLBACK_SNAPSHOT_SYMLINK',
      `Refusing to snapshot symlink: ${filePath}`,
    );
  }
  if (stat.isDirectory()) {
    if (expectedKind !== 'directory') {
      throw new CliInstallError(
        'ROLLBACK_TARGET_TYPE_MISMATCH',
        `Rollback target type mismatch: ${filePath} (expected ${expectedKind}, found directory)`,
      );
    }
    return { path: filePath, existed: true, expectedKind: 'directory', sequence: 0 };
  }
  if (!stat.isFile()) {
    throw new CliInstallError(
      'ROLLBACK_TARGET_TYPE_UNSUPPORTED',
      `Unsupported rollback target type: ${filePath}`,
    );
  }
  if (expectedKind !== 'file') {
    throw new CliInstallError(
      'ROLLBACK_TARGET_TYPE_MISMATCH',
      `Rollback target type mismatch: ${filePath} (expected ${expectedKind}, found file)`,
    );
  }

  const content = await handle.readFile();
  return {
    path: filePath,
    existed: true,
    expectedKind: 'file',
    originalContent: content,
    sequence: 0,
  };
}

/**
 * Rollback install artifacts after a failed auto-install step.
 *
 * Uniform semantics:
 * - existed before install (has originalContent) -> restore via temp+rename
 * - existed before install (no content, e.g. directory) -> leave untouched
 * - did not exist before install -> delete via unlink/rmdir
 */
export async function rollbackArtifacts(
  entries: RollbackEntry[],
  ops: FileOp[],
  errors: string[],
): Promise<void> {
  for (const entry of [...entries].sort((a, b) => b.sequence - a.sequence)) {
    try {
      if (entry.existed && entry.originalContent !== undefined) {
        await restoreFileFromSnapshot(entry, entry.originalContent, ops);
        continue;
      }
      if (entry.existed) continue;

      await removeNewlyCreatedEntry(entry, ops);
    } catch (rollbackErr) {
      errors.push(
        `Rollback failed for ${entry.path}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
      );
    }
  }
}

async function restoreFileFromSnapshot(
  entry: RollbackEntry,
  originalContent: Buffer,
  ops: FileOp[],
): Promise<void> {
  try {
    const stat = await lstat(entry.path);
    if (stat.isSymbolicLink()) {
      throw new CliInstallError(
        'ROLLBACK_RESTORE_SYMLINK',
        `Rollback restore target was replaced by a symlink: ${entry.path}`,
      );
    }
    if (!stat.isFile()) {
      throw new CliInstallError(
        'ROLLBACK_RESTORE_TYPE_CHANGED',
        `Rollback restore target type changed: ${entry.path} (expected file)`,
      );
    }
  } catch (err) {
    if (!isEnoent(err)) throw err;
    // File was deleted — atomic recreate via temp+rename below restores it
  }

  const tmpPath = `${entry.path}.rollback.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tmpPath, originalContent, { flag: 'wx' });
    await rename(tmpPath, entry.path);
    ops.push({ path: entry.path, action: 'written', reason: 'restored pre-install content' });
  } catch (rwErr) {
    try {
      await unlink(tmpPath);
    } catch {
      /* ok */
    }
    throw rwErr;
  }
}

async function removeNewlyCreatedEntry(entry: RollbackEntry, ops: FileOp[]): Promise<void> {
  try {
    await lstat(entry.path);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }

  const stat = await lstat(entry.path);
  if (stat.isSymbolicLink()) {
    throw new CliInstallError(
      'ROLLBACK_REMOVE_SYMLINK',
      `Rollback target was replaced by a symlink: ${entry.path}`,
    );
  }
  if (entry.expectedKind === 'file' && !stat.isFile()) {
    throw new CliInstallError(
      'ROLLBACK_REMOVE_TYPE_CHANGED',
      `Rollback target type changed: ${entry.path} (expected file)`,
    );
  }
  if (entry.expectedKind === 'directory' && !stat.isDirectory()) {
    throw new CliInstallError(
      'ROLLBACK_REMOVE_TYPE_CHANGED',
      `Rollback target type changed: ${entry.path} (expected directory)`,
    );
  }
  if (entry.expectedKind === 'directory') {
    await removeDirectoryRecursively(entry.path);
  } else {
    await unlink(entry.path);
  }
  ops.push({ path: entry.path, action: 'removed', reason: 'rollback after failure' });
}

/** Remove only regular files and directories; never traverse a symlink during rollback. */
async function removeDirectoryRecursively(directoryPath: string): Promise<void> {
  for (const name of await readdir(directoryPath)) {
    const childPath = join(directoryPath, name);
    const childStat = await lstat(childPath);
    if (childStat.isSymbolicLink()) {
      throw new CliInstallError(
        'ROLLBACK_TREE_SYMLINK',
        `Rollback target contains a symlink: ${childPath}`,
      );
    }
    if (childStat.isDirectory()) {
      await removeDirectoryRecursively(childPath);
      continue;
    }
    if (!childStat.isFile()) {
      throw new CliInstallError(
        'ROLLBACK_TARGET_TYPE_UNSUPPORTED',
        `Unsupported rollback target type: ${childPath}`,
      );
    }
    await unlink(childPath);
  }
  await rmdir(directoryPath);
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}
