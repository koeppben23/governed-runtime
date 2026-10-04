/**
 * @module cli/install-transaction-rollback
 * @description Observation-based rollback, recovery, and orphan cleanup for the
 * dependency transaction.
 *
 * Split from install-transaction.ts following the file-size budget; rollback
 * semantics are unchanged.
 *
 * @version v1
 */

import { rename } from 'node:fs/promises';
import {
  fail,
  isEnoent,
  pathExistsNoFollow,
  observePath,
  safeUnlink,
  removeOwnedStagingTree,
  inspectTransactionArtifacts,
} from './install-transaction-utils.js';
import {
  TransactionPhase,
  recoveryActionForPhase,
  persistJournal,
  loadJournal,
  validateJournal,
  findJournals,
  findTransactionArtifacts,
  type DependencyTransaction,
} from './install-transaction-journal.js';

// ─── Rollback ───────────────────────────────────────────────────────────

export function isRollbackPossible(tx: DependencyTransaction): boolean {
  if (!tx.hadOriginal) return tx.phase < TransactionPhase.OriginalDeleted;
  return tx.phase < TransactionPhase.DeletingOriginal;
}

async function refreshRollbackJournal(tx: DependencyTransaction): Promise<void> {
  try {
    const fresh = await loadJournal(tx.journalPath);
    tx.phase = fresh.phase;
    tx.hadOriginal = fresh.hadOriginal;
    tx.savedPath = fresh.savedPath;
    tx.failedPath = fresh.failedPath;
    tx.liveWasIsolated = fresh.liveWasIsolated;
  } catch (err) {
    if (isEnoent(err)) return;
    throw fail(
      'TRANSACTION_JOURNAL_LOAD_FAILED',
      `Cannot load journal: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export async function rollbackDependencyTransaction(tx: DependencyTransaction): Promise<void> {
  await refreshRollbackJournal(tx);

  const recoveryPhase = tx.rollbackFromPhase ?? tx.phase;

  // Observation-based rollback: check filesystem, not just journal
  const livePresent = await observePath(tx.liveModulesPath, 'directory');
  const stagingModPresent = await observePath(tx.stagingModules, 'directory');
  const savedPresent = await observePath(tx.savedPath, 'directory');

  // Detect if swap already happened (rename stagingModules → liveModulesPath)
  const swapHappened =
    livePresent === 'present' &&
    stagingModPresent === 'absent' &&
    recoveryPhase >= TransactionPhase.Swapping;

  // Detect if save already happened (rename liveModulesPath → savedPath)
  const saveHappened =
    savedPresent === 'present' || (tx.hadOriginal && recoveryPhase >= TransactionPhase.OldSaved);

  if (swapHappened && tx.phase < TransactionPhase.LiveIsolated) {
    await isolateLive(tx);
  }
  if (saveHappened && tx.savedPath && tx.phase < TransactionPhase.OriginalRestored) {
    // Set hadOriginal from observation before restore
    tx.hadOriginal = savedPresent === 'present';
    await restoreOriginal(tx);
  }
  await cleanupRollbackArtifacts(tx);

  tx.phase = TransactionPhase.RolledBack;
  await persistJournal(tx);
  await safeUnlink(tx.journalPath);
}

async function isolateLive(tx: DependencyTransaction): Promise<void> {
  tx.failedPath = `${tx.liveModulesPath}.failed.${tx.transactionId}`;
  tx.phase = TransactionPhase.RollbackStarted;
  await persistJournal(tx);

  const livePresent = await pathExistsNoFollow(tx.liveModulesPath);
  const failedPresent = await pathExistsNoFollow(tx.failedPath);

  if (livePresent && !failedPresent) {
    await rename(tx.liveModulesPath, tx.failedPath);
    tx.liveWasIsolated = true;
  } else if (!livePresent && failedPresent) {
    tx.liveWasIsolated = true;
  } else if (!livePresent && !failedPresent) {
    tx.liveWasIsolated = false;
  } else
    throw fail(
      'TRANSACTION_ISOLATION_AMBIGUOUS',
      `Ambiguous isolation: live=${livePresent}, failed=${failedPresent}`,
    );

  tx.phase = TransactionPhase.LiveIsolated;
  await persistJournal(tx);
}

async function restoreOriginal(tx: DependencyTransaction): Promise<void> {
  if (!tx.savedPath)
    throw fail(
      'TRANSACTION_JOURNAL_INCONSISTENT',
      'Journal inconsistent: hadOriginal but no savedPath',
    );
  tx.phase = TransactionPhase.RestoringOriginal;
  await persistJournal(tx);

  const savedPresent = await pathExistsNoFollow(tx.savedPath);
  const livePresent = await pathExistsNoFollow(tx.liveModulesPath);

  if (savedPresent && !livePresent) {
    await rename(tx.savedPath, tx.liveModulesPath);
  } else if (!savedPresent && livePresent) {
    if (!tx.liveWasIsolated)
      throw fail(
        'TRANSACTION_RESTORE_VERIFICATION_FAILED',
        'Cannot verify live is restored original',
      );
    if (!(await pathExistsNoFollow(tx.failedPath)))
      throw fail('TRANSACTION_ISOLATED_REPLACEMENT_MISSING', 'Isolated replacement missing');
  } else
    throw fail(
      'TRANSACTION_RESTORE_AMBIGUOUS',
      `Ambiguous restore: saved=${savedPresent}, live=${livePresent}`,
    );

  tx.phase = TransactionPhase.OriginalRestored;
  await persistJournal(tx);
}

async function cleanupRollbackArtifacts(tx: DependencyTransaction): Promise<void> {
  if (tx.failedPath && tx.phase < TransactionPhase.FailedTreeCleaned) {
    await removeOwnedStagingTree(tx.failedPath, tx.configTargetDir, tx.transactionId);
    tx.phase = TransactionPhase.FailedTreeCleaned;
    await persistJournal(tx);
  }
  if (tx.phase < TransactionPhase.CleanupStaging) {
    await removeOwnedStagingTree(tx.stagingRoot, tx.configTargetDir, tx.transactionId);
    tx.phase = TransactionPhase.CleanupStaging;
    await persistJournal(tx);
  }
  if (tx.hadOriginal && tx.savedPath && tx.phase < TransactionPhase.CleanupSavedDone) {
    await removeOwnedStagingTree(tx.savedPath, tx.configTargetDir, tx.transactionId);
    tx.phase = TransactionPhase.CleanupSavedDone;
    await persistJournal(tx);
  }
}

// ─── Recovery ───────────────────────────────────────────────────────────

export async function recoverOrAbort(configTargetDir: string): Promise<void> {
  const journals = await findJournals(configTargetDir);
  if (journals.length > 1)
    throw fail(
      'TRANSACTION_MULTIPLE_JOURNALS',
      `Multiple incomplete transactions:\n${journals.map((p) => `  ${p}`).join('\n')}`,
    );
  if (journals.length === 0) {
    const orphans = await findTransactionArtifacts(configTargetDir);
    if (orphans.length > 0)
      throw fail(
        'TRANSACTION_ORPHANED_ARTIFACTS',
        `Orphaned artifacts without journal:\n${orphans.map((p) => `  ${p}`).join('\n')}`,
      );
    return;
  }

  const journalPath = journals[0];
  if (journalPath === undefined) {
    throw fail('TRANSACTION_JOURNAL_LOAD_FAILED', 'Cannot load journal: journal path missing');
  }

  let journal: DependencyTransaction;
  try {
    journal = await loadJournal(journalPath);
    validateJournal(journal, configTargetDir);
  } catch (err) {
    throw fail(
      'TRANSACTION_JOURNAL_LOAD_FAILED',
      `Cannot load journal: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  switch (recoveryActionForPhase(journal.phase)) {
    case 'cleanup-rolled-back':
    case 'cleanup-committed':
      await cleanupOrphanedArtifacts(journal);
      await safeUnlink(journal.journalPath);
      return;
    case 'continue-rollback':
      await rollbackDependencyTransaction(journal);
      return;
    case 'continue-commit':
      await continueCommitCleanup(journal);
      return;
    case 'rollback':
      journal.rollbackFromPhase = journal.phase;
      await rollbackDependencyTransaction(journal);
      return;
  }
}

async function continueCommitCleanup(journal: DependencyTransaction): Promise<void> {
  if (journal.hadOriginal && journal.savedPath) {
    await removeOwnedStagingTree(journal.savedPath, journal.configTargetDir, journal.transactionId);
  }
  journal.phase = TransactionPhase.OriginalDeleted;
  await persistJournal(journal);
  const residuals = await inspectTransactionArtifacts(journal);
  if (residuals.length > 0)
    throw fail('TRANSACTION_CLEANUP_INCOMPLETE', `Cleanup incomplete: ${residuals.join(', ')}`);
  journal.phase = TransactionPhase.Committed;
  await persistJournal(journal);
  await safeUnlink(journal.journalPath);
}

async function cleanupOrphanedArtifacts(journal: DependencyTransaction): Promise<void> {
  for (const p of [journal.stagingRoot, journal.savedPath, journal.failedPath]) {
    if (p) await removeOwnedStagingTree(p, journal.configTargetDir, journal.transactionId);
  }
}
