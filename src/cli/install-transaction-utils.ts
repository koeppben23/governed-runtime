/**
 * @module cli/install-transaction-utils
 * @description Filesystem and path-safety primitives for the dependency
 * transaction journal and its rollback/recovery paths.
 *
 * Split from install-transaction.ts following the file-size budget; behavior is
 * unchanged.
 *
 * @version v1
 */

import { lstatSync, realpathSync } from 'node:fs';
import { lstat, rm, unlink } from 'node:fs/promises';
import { basename, dirname, relative } from 'node:path';
import { CliInstallError } from './errors.js';

export function fail(code: string, message: string, options?: ErrorOptions): never {
  throw new CliInstallError(code, message, options);
}

export function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

export async function pathExistsNoFollow(p: string | null): Promise<boolean> {
  if (!p) return false;
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

export async function observePath(
  p: string | null,
  expectedKind: 'file' | 'directory',
): Promise<'absent' | 'present'> {
  if (!p) return 'absent';
  try {
    const stat = await lstat(p);
    if (stat.isSymbolicLink())
      throw fail('TRANSACTION_SYMLINK_NOT_ALLOWED', `Symlink not allowed: ${p}`);
    if (expectedKind === 'directory' && !stat.isDirectory())
      throw fail('TRANSACTION_PATH_TYPE_MISMATCH', `Expected directory, found other type: ${p}`);
    if (expectedKind === 'file' && !stat.isFile())
      throw fail('TRANSACTION_PATH_TYPE_MISMATCH', `Expected file, found other type: ${p}`);
    return 'present';
  } catch (err) {
    if (isEnoent(err)) return 'absent';
    throw err;
  }
}

export async function safeUnlink(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

export function assertPathContained(candidate: string, parent: string): void {
  const rel = relative(parent, candidate);
  if (rel.startsWith('..') || rel === '')
    throw fail('TRANSACTION_PATH_OUTSIDE_TARGET', `Path outside target: ${candidate}`);
}

function assertOwnedTransactionPath(
  candidate: string,
  configTargetDir: string,
  transactionId: string,
): void {
  if (dirname(candidate) !== configTargetDir) {
    throw fail(
      'TRANSACTION_PATH_UNOWNED',
      `Transaction path not direct child of config target: ${candidate}`,
    );
  }

  try {
    const realParent = realpathSync(configTargetDir);
    const realDir = realpathSync(dirname(candidate));
    if (realDir !== realParent)
      throw fail('TRANSACTION_PATH_UNOWNED', `Transaction path real parent differs: ${candidate}`);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }

  const allowed = new Set([
    `node_modules.install.${transactionId}`,
    `node_modules.saved.${transactionId}`,
    `node_modules.failed.${transactionId}`,
  ]);
  if (!allowed.has(basename(candidate)))
    throw fail('TRANSACTION_PATH_UNOWNED', `Unowned transaction path: ${candidate}`);

  try {
    const ts = lstatSync(configTargetDir);
    if (ts.isSymbolicLink())
      throw fail(
        'TRANSACTION_CONFIG_TARGET_SYMLINK',
        `Config target is a symlink: ${configTargetDir}`,
      );
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

export async function removeOwnedStagingTree(
  stagingPath: string | null,
  configTargetDir: string,
  transactionId: string,
): Promise<void> {
  if (!stagingPath) return;
  assertOwnedTransactionPath(stagingPath, configTargetDir, transactionId);

  let rootStat;
  try {
    rootStat = await lstat(stagingPath);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  if (rootStat.isSymbolicLink())
    throw fail('TRANSACTION_STAGING_SYMLINK', `Staging root is a symlink: ${stagingPath}`);
  if (!rootStat.isDirectory())
    throw fail(
      'TRANSACTION_STAGING_NOT_DIRECTORY',
      `Staging root is not a directory: ${stagingPath}`,
    );
  await rm(stagingPath, { recursive: true, force: true });
}

export async function inspectTransactionArtifacts(tx: {
  stagingRoot: string;
  savedPath: string | null;
  failedPath: string | null;
}): Promise<string[]> {
  const residuals: string[] = [];
  for (const c of [tx.stagingRoot, tx.savedPath, tx.failedPath]) {
    if (c && (await pathExistsNoFollow(c))) residuals.push(c);
  }
  return residuals;
}
