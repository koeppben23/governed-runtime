/**
 * @module cli/install-transaction-journal
 * @description Dependency transaction phases and durable journal I/O.
 *
 * Split from install-transaction.ts following the file-size budget; journal
 * semantics and phase values are unchanged.
 *
 * @version v1
 */

import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ensureDir } from '../adapters/persistence.js';
import { assertPathContained, fail, isEnoent } from './install-transaction-utils.js';

// ─── Transaction Phase ──────────────────────────────────────────────────

export enum TransactionPhase {
  StagingActive = 10,
  StagingValidated = 20,
  SavingOld = 30,
  OldSaved = 40,
  Swapping = 50,
  Swapped = 60,
  CleaningStaging = 65,
  StagingCleaned = 70,
  DeletingOriginal = 80,
  OriginalDeleted = 90,
  Committed = 100,
  RollbackStarted = 110,
  LiveIsolated = 120,
  RestoringOriginal = 125,
  OriginalRestored = 130,
  FailedTreeCleaned = 140,
  CleanupStaging = 150,
  CleanupSavedDone = 160,
  RolledBack = 200,
}

const VALID_PHASES = new Set<number>(
  Object.values(TransactionPhase).filter((v): v is number => typeof v === 'number'),
);

export type RecoveryAction =
  | 'rollback'
  | 'continue-rollback'
  | 'continue-commit'
  | 'cleanup-committed'
  | 'cleanup-rolled-back';

export function recoveryActionForPhase(phase: TransactionPhase): RecoveryAction {
  if (phase === TransactionPhase.RolledBack) return 'cleanup-rolled-back';
  if (phase >= TransactionPhase.RollbackStarted && phase < TransactionPhase.RolledBack) {
    return 'continue-rollback';
  }
  if (phase === TransactionPhase.Committed) return 'cleanup-committed';
  if (phase >= TransactionPhase.DeletingOriginal && phase < TransactionPhase.Committed) {
    return 'continue-commit';
  }
  if (phase >= TransactionPhase.StagingActive && phase < TransactionPhase.DeletingOriginal) {
    return 'rollback';
  }
  throw fail(
    'TRANSACTION_RECOVERY_PHASE_UNSUPPORTED',
    `Unsupported recovery phase: ${TransactionPhase[phase]}`,
  );
}

// ─── Dependency Transaction ─────────────────────────────────────────────

export interface DependencyTransaction {
  transactionId: string;
  phase: TransactionPhase;
  rollbackFromPhase?: TransactionPhase;
  configTargetDir: string;
  liveModulesPath: string;
  stagingRoot: string;
  stagingModules: string;
  savedPath: string | null;
  failedPath: string | null;
  hadOriginal: boolean;
  liveWasIsolated: boolean;
  journalPath: string;
  vendorTarballPath: string;
  startedAt: string;
}

// ─── Journal ────────────────────────────────────────────────────────────

export async function persistJournal(tx: DependencyTransaction): Promise<void> {
  const tmpPath = `${tx.journalPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await ensureDir(dirname(tx.journalPath));
    await writeFile(tmpPath, JSON.stringify(tx, null, 2) + '\n', { flag: 'wx' });
    await rename(tmpPath, tx.journalPath);
  } catch (writeErr) {
    try {
      await unlink(tmpPath);
    } catch {
      /* best-effort, original error takes priority */
    }
    throw writeErr;
  }
}

export async function loadJournal(journalPath: string): Promise<DependencyTransaction> {
  return JSON.parse(await readFile(journalPath, 'utf-8')) as DependencyTransaction;
}

export function validateJournal(tx: DependencyTransaction, configTargetDir: string): void {
  if (!VALID_PHASES.has(tx.phase))
    throw fail('TRANSACTION_PHASE_INVALID', `Invalid transaction phase: ${tx.phase}`);
  const expectedName = `.flowguard-dependency-transaction.${tx.transactionId}.json`;
  if (basename(tx.journalPath) !== expectedName)
    throw fail('TRANSACTION_JOURNAL_FILENAME_MISMATCH', 'Journal filename mismatch');
  for (const p of [tx.stagingRoot, tx.savedPath, tx.failedPath]) {
    if (p) assertPathContained(p, configTargetDir);
  }
}

export async function findJournals(configTargetDir: string): Promise<string[]> {
  try {
    const entries = await readdir(configTargetDir);
    return entries
      .filter((e) => e.startsWith('.flowguard-dependency-transaction.') && e.endsWith('.json'))
      .map((e) => join(configTargetDir, e))
      .sort();
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

export async function findTransactionArtifacts(configTargetDir: string): Promise<string[]> {
  try {
    const entries = await readdir(configTargetDir);
    return entries
      .filter(
        (e) =>
          e.startsWith('node_modules.') &&
          (e.includes('.install.') || e.includes('.saved.') || e.includes('.failed.')),
      )
      .map((e) => join(configTargetDir, e));
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}
