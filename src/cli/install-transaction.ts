/**
 * @module cli/install-transaction
 * @description Journal-based dependency transaction for safe npm/bun install + rollback.
 *
 * @version v2
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile, lstat } from 'node:fs/promises';
import { execFileSync, execSync, type ExecSyncOptions } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureDir } from '../adapters/persistence.js';
import type { FileOp } from './install-types.js';
import type { RollbackEntry } from './install-helpers-rollback.js';
import {
  fail,
  isEnoent,
  observePath,
  removeOwnedStagingTree,
  inspectTransactionArtifacts,
  safeUnlink,
} from './install-transaction-utils.js';
import {
  TransactionPhase,
  persistJournal,
  type DependencyTransaction,
} from './install-transaction-journal.js';

interface DependencyTransactionContext {
  warnings: string[];
  ops: FileOp[];
}

interface DependencyTransactionSnapshot {
  configTargetDir: string;
}

// ─── Package Manager ────────────────────────────────────────────────────

function executeNpm(args: string[], options: ExecSyncOptions): void {
  if (process.platform === 'win32') {
    execSync(`npm ${args.join(' ')}`, options);
    return;
  }
  execFileSync('npm', args, options);
}

function detectPackageManager(): 'bun' | 'npm' | null {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return 'bun';
  } catch {
    // Try npm when bun is unavailable.
  }
  try {
    executeNpm(['--version'], { stdio: 'ignore', timeout: 5000 });
    return 'npm';
  } catch {
    // No supported package manager is available.
  }
  return null;
}

const INSTALL_TIMEOUT = 5 * 60 * 1000;

function doPackageInstall(pm: 'npm' | 'bun', stagingRoot: string): void {
  try {
    if (pm === 'npm') {
      executeNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev'], {
        cwd: stagingRoot,
        stdio: 'pipe',
        timeout: INSTALL_TIMEOUT,
      });
    } else {
      execFileSync('bun', ['install', '--cwd', '.', '--ignore-scripts', '--production'], {
        cwd: stagingRoot,
        stdio: 'pipe',
        timeout: INSTALL_TIMEOUT,
      });
    }
  } catch (error) {
    throw fail(
      'DEPENDENCY_INSTALL_FAILED',
      `Dependency install failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

// ─── Create Transaction (no mutations) ──────────────────────────────────

export async function createDependencyTransaction(
  snapshot: DependencyTransactionSnapshot,
  vendorTarballPath: string,
): Promise<DependencyTransaction> {
  const transactionId = randomUUID();
  const configTargetDir = snapshot.configTargetDir;
  const liveModulesPath = join(configTargetDir, 'node_modules');
  const stagingRoot = join(configTargetDir, `node_modules.install.${transactionId}`);
  const stagingModules = join(stagingRoot, 'node_modules');
  const journalPath = join(
    configTargetDir,
    `.flowguard-dependency-transaction.${transactionId}.json`,
  );

  return {
    transactionId,
    phase: TransactionPhase.StagingActive,
    configTargetDir,
    liveModulesPath,
    stagingRoot,
    stagingModules,
    savedPath: null,
    failedPath: null,
    hadOriginal: false,
    liveWasIsolated: false,
    journalPath,
    vendorTarballPath,
    startedAt: new Date().toISOString(),
  };
}

// ─── Execute Transaction (mutating, but no local rollback) ──────────────

export async function executeDependencyTransaction(tx: DependencyTransaction): Promise<void> {
  const pm = detectPackageManager();
  if (pm === null) throw fail('PACKAGE_MANAGER_UNAVAILABLE', 'Neither bun nor npm found in PATH.');

  // --- Staging ---
  tx.phase = TransactionPhase.StagingActive;
  await persistJournal(tx);

  await ensureDir(tx.configTargetDir);
  await mkdir(tx.stagingRoot);
  await writeFile(
    join(tx.stagingRoot, 'package.json'),
    JSON.stringify({
      dependencies: { '@flowguard/core': pathToFileURL(tx.vendorTarballPath).href },
    }),
    { flag: 'w' },
  );

  doPackageInstall(pm, tx.stagingRoot);

  if ((await observePath(tx.stagingModules, 'directory')) !== 'present')
    throw fail('TRANSACTION_STAGING_NODE_MODULES_MISSING', 'Staging: node_modules not created.');
  if ((await observePath(join(tx.stagingModules, '@flowguard', 'core'), 'directory')) !== 'present')
    throw fail('TRANSACTION_STAGING_CORE_MISSING', 'Staging: @flowguard/core not found.');

  tx.phase = TransactionPhase.StagingValidated;
  await persistJournal(tx);

  // --- SavingOld (observation-based, typed) ---
  tx.savedPath = join(tx.configTargetDir, `node_modules.saved.${tx.transactionId}`);
  tx.phase = TransactionPhase.SavingOld;
  await persistJournal(tx);

  const livePres = await observePath(tx.liveModulesPath, 'directory');
  const savedPres = await observePath(tx.savedPath, 'directory');

  if (livePres === 'present' && savedPres === 'absent') {
    await rename(tx.liveModulesPath, tx.savedPath);
    tx.hadOriginal = true;
  } else if (livePres === 'absent' && savedPres === 'present') {
    tx.hadOriginal = true;
  } else if (livePres === 'present' && savedPres === 'present') {
    throw fail('TRANSACTION_SAVE_OLD_AMBIGUOUS', 'Ambiguous save-old: both live and saved exist');
  } else {
    tx.hadOriginal = false;
    tx.savedPath = null;
  }

  tx.phase = TransactionPhase.OldSaved;
  await persistJournal(tx);

  // --- Swap ---
  tx.phase = TransactionPhase.Swapping;
  await persistJournal(tx);

  await rename(tx.stagingModules, tx.liveModulesPath);

  tx.phase = TransactionPhase.Swapped;
  await persistJournal(tx);
}

// ─── Commit ─────────────────────────────────────────────────────────────

export async function commitDependencyTransaction(
  tx: DependencyTransaction,
  ctx: DependencyTransactionContext,
): Promise<void> {
  tx.phase = TransactionPhase.CleaningStaging;
  await persistJournal(tx);
  await removeOwnedStagingTree(tx.stagingRoot, tx.configTargetDir, tx.transactionId);
  tx.phase = TransactionPhase.StagingCleaned;
  await persistJournal(tx);

  tx.phase = TransactionPhase.DeletingOriginal;
  await persistJournal(tx);

  if (tx.hadOriginal) {
    if (!tx.savedPath)
      throw fail(
        'TRANSACTION_JOURNAL_INCONSISTENT',
        'Journal inconsistent: hadOriginal but no savedPath',
      );
    try {
      await removeOwnedStagingTree(tx.savedPath, tx.configTargetDir, tx.transactionId);
    } catch (err) {
      ctx.warnings.push(
        `FlowGuard installed successfully, but previous backup could not be removed ` +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          `Retry on next install. Journal: ${tx.journalPath}`,
      );
      return;
    }
  }

  tx.phase = TransactionPhase.OriginalDeleted;
  await persistJournal(tx);

  const residuals = await inspectTransactionArtifacts(tx);
  if (residuals.length > 0)
    throw fail('TRANSACTION_CLEANUP_INCOMPLETE', `Cleanup incomplete: ${residuals.join(', ')}`);

  tx.phase = TransactionPhase.Committed;
  await persistJournal(tx);
  await safeUnlink(tx.journalPath);
  ctx.ops.push({ path: tx.liveModulesPath, action: 'written' });
}

// ─── MutationJournal ────────────────────────────────────────────────────

export class MutationJournal {
  private entries: RollbackEntry[] = [];
  private nextSequence = 0;

  record(entry: Omit<RollbackEntry, 'sequence'>): RollbackEntry {
    const complete = { ...entry, sequence: this.nextSequence++ };
    this.entries.push(complete);
    return complete;
  }

  deduplicated(): RollbackEntry[] {
    const byPath = new Map<string, RollbackEntry>();
    for (const entry of this.entries) {
      const existing = byPath.get(entry.path);
      if (existing && existing.expectedKind !== entry.expectedKind)
        throw fail(
          'ROLLBACK_TYPE_CONFLICT',
          `Type conflict: ${entry.path} (${existing.expectedKind}, ${entry.expectedKind})`,
        );
      if (existing) continue;
      byPath.set(entry.path, entry);
    }
    return [...byPath.values()].sort((a, b) => b.sequence - a.sequence);
  }
}

export async function ensureDirTracked(dir: string, journal: MutationJournal): Promise<void> {
  // Walk up to find the deepest existing ancestor, collecting missing parents
  const missing: string[] = [];
  let current = dir;
  while (true) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw fail('TRANSACTION_SYMLINK_NOT_ALLOWED', `Symlink not allowed: ${current}`);
      if (!stat.isDirectory())
        throw fail('TRANSACTION_PATH_TYPE_MISMATCH', `Expected directory: ${current}`);
      break; // found existing directory — ancestors exist
    } catch (err) {
      if (!isEnoent(err)) throw err;
      missing.push(current);
      current = dirname(current);
    }
  }

  // Create missing directories bottom-up (parent-first), journal each
  for (const path of missing.reverse()) {
    await mkdir(path);
    journal.record({ path, existed: false, expectedKind: 'directory' });
  }
}
