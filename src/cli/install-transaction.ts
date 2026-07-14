/**
 * @module cli/install-transaction
 * @description Journal-based dependency transaction for safe npm/bun install + rollback.
 *
 * @version v2
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, unlink, writeFile, lstat, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, basename } from 'node:path';
import { ensureDir } from '../adapters/persistence.js';
import type { FileOp, CliArgs } from './install-types.js';
import type { RollbackEntry } from './install-helpers.js';
import type { InstallContext, SnapshotResult } from './install-steps.js';

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
  startedAt: string;
}

// ─── Utilities ──────────────────────────────────────────────────────────

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

async function pathExistsNoFollow(p: string | null): Promise<boolean> {
  if (!p) return false;
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch {
    /* ok */
  }
}

function assertPathContained(candidate: string, parent: string): void {
  const rel = relative(parent, candidate);
  if (rel.startsWith('..') || rel === '') throw new Error(`Path outside target: ${candidate}`);
}

function assertOwnedTransactionPath(
  candidate: string,
  configTargetDir: string,
  transactionId: string,
): void {
  if (dirname(candidate) !== configTargetDir) {
    throw new Error(`Transaction path not direct child of config target: ${candidate}`);
  }

  try {
    const realParent = realpathSync(configTargetDir);
    const realDir = realpathSync(dirname(candidate));
    if (realDir !== realParent)
      throw new Error(`Transaction path real parent differs: ${candidate}`);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }

  const allowed = new Set([
    `node_modules.install.${transactionId}`,
    `node_modules.saved.${transactionId}`,
    `node_modules.failed.${transactionId}`,
  ]);
  if (!allowed.has(basename(candidate))) throw new Error(`Unowned transaction path: ${candidate}`);

  try {
    const ts = lstatSync(configTargetDir);
    if (ts.isSymbolicLink()) throw new Error(`Config target is a symlink: ${configTargetDir}`);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

async function removeOwnedStagingTree(
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
  if (rootStat.isSymbolicLink()) throw new Error(`Staging root is a symlink: ${stagingPath}`);
  if (!rootStat.isDirectory()) throw new Error(`Staging root is not a directory: ${stagingPath}`);
  await rm(stagingPath, { recursive: true, force: true });
}

async function inspectTransactionArtifacts(tx: DependencyTransaction): Promise<string[]> {
  const residuals: string[] = [];
  for (const c of [tx.stagingRoot, tx.savedPath, tx.failedPath]) {
    if (c && (await pathExistsNoFollow(c))) residuals.push(c);
  }
  return residuals;
}

async function inspectPaths(tx: DependencyTransaction) {
  return {
    livePresent: await pathExistsNoFollow(tx.liveModulesPath),
    savedPresent: await pathExistsNoFollow(tx.savedPath),
    stagingPresent: await pathExistsNoFollow(tx.stagingRoot),
    failedPresent: await pathExistsNoFollow(tx.failedPath),
  };
}

// ─── Journal ────────────────────────────────────────────────────────────

async function persistJournal(tx: DependencyTransaction): Promise<void> {
  const tmpPath = `${tx.journalPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await ensureDir(dirname(tx.journalPath));
    await writeFile(tmpPath, JSON.stringify(tx, null, 2) + '\n', { flag: 'wx' });
    await rename(tmpPath, tx.journalPath);
  } catch (err) {
    await safeUnlink(tmpPath);
    throw err;
  }
}

async function loadJournal(journalPath: string): Promise<DependencyTransaction> {
  return JSON.parse(await readFile(journalPath, 'utf-8')) as DependencyTransaction;
}

function validateJournal(tx: DependencyTransaction, configTargetDir: string): void {
  if (!VALID_PHASES.has(tx.phase)) throw new Error(`Invalid transaction phase: ${tx.phase}`);
  const expectedName = `.flowguard-dependency-transaction.${tx.transactionId}.json`;
  if (basename(tx.journalPath) !== expectedName) throw new Error('Journal filename mismatch');
  for (const p of [tx.stagingRoot, tx.savedPath, tx.failedPath]) {
    if (p) assertPathContained(p, configTargetDir);
  }
}

async function findJournals(configTargetDir: string): Promise<string[]> {
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

async function findTransactionArtifacts(configTargetDir: string): Promise<string[]> {
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

// ─── Package Manager ────────────────────────────────────────────────────

function detectPackageManager(): 'bun' | 'npm' | null {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return 'bun';
  } catch {}
  try {
    execFileSync('npm', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return 'npm';
  } catch {}
  return null;
}

const INSTALL_TIMEOUT = 5 * 60 * 1000;

function doPackageInstall(pm: 'npm' | 'bun', stagingRoot: string): void {
  if (pm === 'npm') {
    execFileSync(
      'npm',
      ['install', '--prefix', '.', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev'],
      {
        cwd: stagingRoot,
        stdio: 'pipe',
        timeout: INSTALL_TIMEOUT,
      },
    );
  } else {
    execFileSync('bun', ['install', '--cwd', '.', '--ignore-scripts', '--production'], {
      cwd: stagingRoot,
      stdio: 'pipe',
      timeout: INSTALL_TIMEOUT,
    });
  }
}

// ─── Create Transaction (no mutations) ──────────────────────────────────

export async function createDependencyTransaction(
  ctx: InstallContext,
  snapshot: SnapshotResult,
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
    startedAt: new Date().toISOString(),
  };
}

// ─── Execute Transaction (mutating, but no local rollback) ──────────────

export async function executeDependencyTransaction(tx: DependencyTransaction): Promise<void> {
  const pm = detectPackageManager();
  if (pm === null) throw new Error('Neither bun nor npm found in PATH.');

  // --- Staging ---
  tx.phase = TransactionPhase.StagingActive;
  await persistJournal(tx);

  await ensureDir(tx.configTargetDir);
  await mkdir(tx.stagingRoot);
  await writeFile(
    join(tx.stagingRoot, 'package.json'),
    JSON.stringify({ dependencies: { '@flowguard/core': `${tx.stagingRoot}` } }),
    { flag: 'w' },
  );

  doPackageInstall(pm, tx.stagingRoot);

  if (!existsSync(tx.stagingModules)) throw new Error('Staging: node_modules not created.');
  if (!existsSync(join(tx.stagingModules, '@flowguard', 'core')))
    throw new Error('Staging: @flowguard/core not found.');

  tx.phase = TransactionPhase.StagingValidated;
  await persistJournal(tx);

  // --- SavingOld (observation-based) ---
  tx.savedPath = join(tx.configTargetDir, `node_modules.saved.${tx.transactionId}`);
  tx.phase = TransactionPhase.SavingOld;
  await persistJournal(tx);

  const liveExists = existsSync(tx.liveModulesPath);
  const savedExists = existsSync(tx.savedPath);

  if (liveExists && !savedExists) {
    await rename(tx.liveModulesPath, tx.savedPath);
    tx.hadOriginal = true;
  } else if (!liveExists && savedExists) {
    tx.hadOriginal = true;
  } else if (liveExists && savedExists) {
    throw new Error('Ambiguous save-old: both live and saved exist');
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
  ctx: InstallContext,
): Promise<void> {
  tx.phase = TransactionPhase.CleaningStaging;
  await persistJournal(tx);
  await removeOwnedStagingTree(tx.stagingRoot, tx.configTargetDir, tx.transactionId);
  tx.phase = TransactionPhase.StagingCleaned;
  await persistJournal(tx);

  tx.phase = TransactionPhase.DeletingOriginal;
  await persistJournal(tx);

  if (tx.hadOriginal) {
    if (!tx.savedPath) throw new Error('Journal inconsistent: hadOriginal but no savedPath');
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
  if (residuals.length > 0) throw new Error(`Cleanup incomplete: ${residuals.join(', ')}`);

  tx.phase = TransactionPhase.Committed;
  await persistJournal(tx);
  await safeUnlink(tx.journalPath);
}

// ─── Rollback ───────────────────────────────────────────────────────────

export function isRollbackPossible(tx: DependencyTransaction): boolean {
  if (!tx.hadOriginal) return tx.phase < TransactionPhase.OriginalDeleted;
  return tx.phase < TransactionPhase.DeletingOriginal;
}

export async function rollbackDependencyTransaction(tx: DependencyTransaction): Promise<void> {
  try {
    const fresh = await loadJournal(tx.journalPath);
    tx.phase = fresh.phase;
    tx.hadOriginal = fresh.hadOriginal;
    tx.savedPath = fresh.savedPath;
    tx.failedPath = fresh.failedPath;
    tx.liveWasIsolated = fresh.liveWasIsolated;
  } catch (err) {
    if (!isEnoent(err))
      throw new Error(`Cannot load journal: ${err instanceof Error ? err.message : String(err)}`);
  }

  const recoveryPhase = tx.rollbackFromPhase ?? tx.phase;
  const hadLiveSwap = recoveryPhase >= TransactionPhase.Swapped;
  const hadSavedOriginal = tx.hadOriginal && recoveryPhase >= TransactionPhase.OldSaved;

  if (hadLiveSwap && tx.phase < TransactionPhase.LiveIsolated) {
    await isolateLive(tx);
  }
  if (hadSavedOriginal && tx.phase < TransactionPhase.OriginalRestored) {
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
  } else throw new Error(`Ambiguous isolation: live=${livePresent}, failed=${failedPresent}`);

  tx.phase = TransactionPhase.LiveIsolated;
  await persistJournal(tx);
}

async function restoreOriginal(tx: DependencyTransaction): Promise<void> {
  if (!tx.savedPath) throw new Error('Journal inconsistent: hadOriginal but no savedPath');
  tx.phase = TransactionPhase.RestoringOriginal;
  await persistJournal(tx);

  const savedPresent = await pathExistsNoFollow(tx.savedPath);
  const livePresent = await pathExistsNoFollow(tx.liveModulesPath);

  if (savedPresent && !livePresent) {
    await rename(tx.savedPath, tx.liveModulesPath);
  } else if (!savedPresent && livePresent) {
    if (!tx.liveWasIsolated) throw new Error('Cannot verify live is restored original');
    if (!(await pathExistsNoFollow(tx.failedPath))) throw new Error('Isolated replacement missing');
  } else throw new Error(`Ambiguous restore: saved=${savedPresent}, live=${livePresent}`);

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
    throw new Error(
      `Multiple incomplete transactions:\n${journals.map((p) => `  ${p}`).join('\n')}`,
    );
  if (journals.length === 0) {
    const orphans = await findTransactionArtifacts(configTargetDir);
    if (orphans.length > 0)
      throw new Error(
        `Orphaned artifacts without journal:\n${orphans.map((p) => `  ${p}`).join('\n')}`,
      );
    return;
  }

  let journal: DependencyTransaction;
  try {
    journal = await loadJournal(journals[0]!);
    validateJournal(journal, configTargetDir);
  } catch (err) {
    throw new Error(`Cannot load journal: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (
    journal.phase >= TransactionPhase.RollbackStarted &&
    journal.phase < TransactionPhase.RolledBack
  ) {
    await rollbackDependencyTransaction(journal);
    return;
  }
  if (journal.phase === TransactionPhase.DeletingOriginal) {
    await continueCommitCleanup(journal);
    return;
  }
  if (journal.phase === TransactionPhase.Committed) {
    await cleanupOrphanedArtifacts(journal);
    await safeUnlink(journal.journalPath);
    return;
  }

  const observed = await inspectPaths(journal);
  const hints = buildRecoveryHints(journal, observed);
  throw new Error(
    `Incomplete transaction.\nPhase: ${TransactionPhase[journal.phase]}.\nTransactionId: ${journal.transactionId}.\n${hints}`,
  );
}

async function continueCommitCleanup(journal: DependencyTransaction): Promise<void> {
  if (journal.hadOriginal && journal.savedPath) {
    await removeOwnedStagingTree(journal.savedPath, journal.configTargetDir, journal.transactionId);
  }
  journal.phase = TransactionPhase.OriginalDeleted;
  await persistJournal(journal);
  const residuals = await inspectTransactionArtifacts(journal);
  if (residuals.length > 0) throw new Error(`Cleanup incomplete: ${residuals.join(', ')}`);
  journal.phase = TransactionPhase.Committed;
  await persistJournal(journal);
  await safeUnlink(journal.journalPath);
}

async function cleanupOrphanedArtifacts(journal: DependencyTransaction): Promise<void> {
  for (const p of [journal.stagingRoot, journal.savedPath, journal.failedPath]) {
    if (p) await removeOwnedStagingTree(p, journal.configTargetDir, journal.transactionId);
  }
}

function buildRecoveryHints(
  journal: DependencyTransaction,
  observed: {
    livePresent: boolean;
    savedPresent: boolean;
    stagingPresent: boolean;
    failedPresent: boolean;
  },
): string {
  const lines: string[] = [];
  lines.push(`Live: ${observed.livePresent ? 'present' : 'absent'}`);
  if (journal.savedPath)
    lines.push(`Saved: ${observed.savedPresent ? journal.savedPath : 'absent'}`);
  lines.push(`Staging: ${observed.stagingPresent ? journal.stagingRoot : 'absent'}`);
  lines.push(`Journal: ${journal.journalPath}`);
  if (journal.phase === TransactionPhase.SavingOld || journal.phase === TransactionPhase.OldSaved) {
    lines.push(`Restore: mv ${journal.savedPath} ${journal.liveModulesPath}`);
  }
  return lines.join('\n');
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
      if (existing?.expectedKind !== entry.expectedKind)
        throw new Error(`Type conflict: ${entry.path}`);
      if (existing) continue;
      byPath.set(entry.path, entry);
    }
    return [...byPath.values()].sort((a, b) => b.sequence - a.sequence);
  }
}

export async function ensureDirTracked(dir: string, journal: MutationJournal): Promise<void> {
  try {
    await mkdir(dir);
    journal.record({ path: dir, existed: false, expectedKind: 'directory' });
  } catch (err) {
    if (!isEnoent(err) && !(err instanceof Error && 'code' in err && err.code === 'EEXIST'))
      throw err;
    const dirStat = await lstat(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink())
      throw new Error(`Expected directory: ${dir}`);
    journal.record({ path: dir, existed: true, expectedKind: 'directory' });
  }
}
