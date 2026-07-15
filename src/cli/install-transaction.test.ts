import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recoverOrAbort,
  recoveryActionForPhase,
  TransactionPhase,
  type DependencyTransaction,
} from './install-transaction.js';

let testDir: string | undefined;

afterEach(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
  testDir = undefined;
});

async function writeMarker(path: string, marker: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'marker'), marker, 'utf-8');
}

async function markerIs(path: string, marker: string): Promise<boolean> {
  return (await readFile(join(path, 'marker'), 'utf-8')) === marker;
}

type RecoveryCase = {
  name: string;
  phase: TransactionPhase;
  live: 'original' | 'replacement' | 'absent';
  saved: boolean;
  staging: boolean;
  hadOriginal: boolean;
};

const RECOVERY_CASES: RecoveryCase[] = [
  {
    name: 'StagingActive removes the staging tree',
    phase: TransactionPhase.StagingActive,
    live: 'original',
    saved: false,
    staging: true,
    hadOriginal: false,
  },
  {
    name: 'StagingValidated removes validated staging modules',
    phase: TransactionPhase.StagingValidated,
    live: 'original',
    saved: false,
    staging: true,
    hadOriginal: false,
  },
  {
    name: 'SavingOld restores a renamed original tree',
    phase: TransactionPhase.SavingOld,
    live: 'absent',
    saved: true,
    staging: true,
    hadOriginal: false,
  },
  {
    name: 'OldSaved restores the original tree',
    phase: TransactionPhase.OldSaved,
    live: 'absent',
    saved: true,
    staging: true,
    hadOriginal: true,
  },
  {
    name: 'Swapping restores the original tree after a completed rename',
    phase: TransactionPhase.Swapping,
    live: 'replacement',
    saved: true,
    staging: false,
    hadOriginal: true,
  },
  {
    name: 'Swapped restores the original tree',
    phase: TransactionPhase.Swapped,
    live: 'replacement',
    saved: true,
    staging: false,
    hadOriginal: true,
  },
  {
    name: 'CleaningStaging restores the original tree',
    phase: TransactionPhase.CleaningStaging,
    live: 'replacement',
    saved: true,
    staging: false,
    hadOriginal: true,
  },
  {
    name: 'StagingCleaned restores the original tree',
    phase: TransactionPhase.StagingCleaned,
    live: 'replacement',
    saved: true,
    staging: false,
    hadOriginal: true,
  },
];

async function createRollbackFixture(options: {
  phase: TransactionPhase;
  live: 'original' | 'replacement' | 'absent';
  saved: boolean;
  failed: boolean;
  staging: boolean;
  liveWasIsolated: boolean;
}): Promise<DependencyTransaction> {
  testDir = await mkdtemp(join(tmpdir(), 'flowguard-rollback-recovery-'));
  const transactionId = 'rollback-recovery-test';
  const liveModulesPath = join(testDir, 'node_modules');
  const stagingRoot = join(testDir, `node_modules.install.${transactionId}`);
  const savedPath = join(testDir, `node_modules.saved.${transactionId}`);
  const failedPath = join(testDir, `node_modules.failed.${transactionId}`);
  const journalPath = join(testDir, `.flowguard-dependency-transaction.${transactionId}.json`);
  const journal: DependencyTransaction = {
    transactionId,
    phase: options.phase,
    configTargetDir: testDir,
    liveModulesPath,
    stagingRoot,
    stagingModules: join(stagingRoot, 'node_modules'),
    savedPath,
    failedPath,
    hadOriginal: true,
    liveWasIsolated: options.liveWasIsolated,
    journalPath,
    vendorTarballPath: join(testDir, 'flowguard-core.tgz'),
    startedAt: new Date().toISOString(),
  };

  if (options.live !== 'absent') await writeMarker(liveModulesPath, options.live);
  if (options.saved) await writeMarker(savedPath, 'original');
  if (options.failed) await writeMarker(failedPath, 'replacement');
  if (options.staging) await writeMarker(journal.stagingModules, 'replacement');
  await writeFile(journalPath, JSON.stringify(journal), 'utf-8');
  return journal;
}

async function expectOriginalRestored(journal: DependencyTransaction): Promise<void> {
  await expectTransactionCleaned(journal, 'original');
}

async function expectTransactionCleaned(
  journal: DependencyTransaction,
  expectedLiveMarker: string,
): Promise<void> {
  await recoverOrAbort(journal.configTargetDir);
  expect(existsSync(journal.journalPath)).toBe(false);
  expect(existsSync(journal.stagingRoot)).toBe(false);
  expect(existsSync(journal.savedPath!)).toBe(false);
  expect(existsSync(journal.failedPath!)).toBe(false);
  expect(await markerIs(journal.liveModulesPath, expectedLiveMarker)).toBe(true);
}

describe('recoverOrAbort', () => {
  describe('rolls back interrupted install phases', () => {
    it.each(RECOVERY_CASES)(
      'recovers $name',
      async ({ phase, live, saved, staging, hadOriginal }) => {
        testDir = await mkdtemp(join(tmpdir(), 'flowguard-install-recovery-'));
        const transactionId = 'recovery-test';
        const liveModulesPath = join(testDir, 'node_modules');
        const stagingRoot = join(testDir, `node_modules.install.${transactionId}`);
        const stagingModules = join(stagingRoot, 'node_modules');
        const savedPath = join(testDir, `node_modules.saved.${transactionId}`);
        const journalPath = join(
          testDir,
          `.flowguard-dependency-transaction.${transactionId}.json`,
        );
        const journal: DependencyTransaction = {
          transactionId,
          phase,
          configTargetDir: testDir,
          liveModulesPath,
          stagingRoot,
          stagingModules,
          savedPath,
          failedPath: null,
          hadOriginal,
          liveWasIsolated: false,
          journalPath,
          vendorTarballPath: join(testDir, 'flowguard-core.tgz'),
          startedAt: new Date().toISOString(),
        };

        if (live !== 'absent') await writeMarker(liveModulesPath, live);
        if (saved) await writeMarker(savedPath, 'original');
        if (staging) await writeMarker(stagingModules, 'replacement');
        else if (phase === TransactionPhase.Swapping) {
          await mkdir(stagingRoot, { recursive: true });
          await writeFile(join(stagingRoot, 'package.json'), '{}');
        }
        await writeFile(journalPath, JSON.stringify(journal), 'utf-8');

        await recoverOrAbort(testDir);

        expect(existsSync(journalPath)).toBe(false);
        expect(existsSync(stagingRoot)).toBe(false);
        expect(existsSync(savedPath)).toBe(false);
        expect(await markerIs(liveModulesPath, 'original')).toBe(true);
      },
    );
  });

  describe('continues interrupted rollback phases', () => {
    it('continues RollbackStarted by isolating the replacement and restoring the original', async () => {
      await expectOriginalRestored(
        await createRollbackFixture({
          phase: TransactionPhase.RollbackStarted,
          live: 'replacement',
          saved: true,
          failed: false,
          staging: false,
          liveWasIsolated: false,
        }),
      );
    });

    it('continues LiveIsolated by restoring and cleaning the original tree', async () => {
      await expectOriginalRestored(
        await createRollbackFixture({
          phase: TransactionPhase.LiveIsolated,
          live: 'absent',
          saved: true,
          failed: true,
          staging: true,
          liveWasIsolated: true,
        }),
      );
    });

    it.each([
      { name: 'before the original rename', live: 'absent' as const, saved: true },
      { name: 'after the original rename', live: 'original' as const, saved: false },
    ])('continues RestoringOriginal $name', async ({ live, saved }) => {
      await expectOriginalRestored(
        await createRollbackFixture({
          phase: TransactionPhase.RestoringOriginal,
          live,
          saved,
          failed: true,
          staging: true,
          liveWasIsolated: true,
        }),
      );
    });

    it.each([
      {
        name: 'OriginalRestored',
        phase: TransactionPhase.OriginalRestored,
        saved: false,
        failed: true,
        staging: true,
      },
      {
        name: 'FailedTreeCleaned',
        phase: TransactionPhase.FailedTreeCleaned,
        saved: false,
        failed: false,
        staging: true,
      },
      {
        name: 'CleanupStaging',
        phase: TransactionPhase.CleanupStaging,
        saved: true,
        failed: false,
        staging: false,
      },
      {
        name: 'CleanupSavedDone',
        phase: TransactionPhase.CleanupSavedDone,
        saved: false,
        failed: false,
        staging: false,
      },
    ])('continues $name cleanup', async ({ phase, saved, failed, staging }) => {
      await expectOriginalRestored(
        await createRollbackFixture({
          phase,
          live: 'original',
          saved,
          failed,
          staging,
          liveWasIsolated: true,
        }),
      );
    });
  });

  describe('cleans terminal phases', () => {
    it('cleans RolledBack artifacts without changing the original live tree', async () => {
      await expectOriginalRestored(
        await createRollbackFixture({
          phase: TransactionPhase.RolledBack,
          live: 'original',
          saved: true,
          failed: true,
          staging: true,
          liveWasIsolated: true,
        }),
      );
    });

    it('cleans Committed artifacts without changing the committed live tree', async () => {
      await expectTransactionCleaned(
        await createRollbackFixture({
          phase: TransactionPhase.Committed,
          live: 'replacement',
          saved: true,
          failed: true,
          staging: true,
          liveWasIsolated: false,
        }),
        'replacement',
      );
    });
  });

  describe('continues irreversible commit cleanup', () => {
    it.each([TransactionPhase.DeletingOriginal, TransactionPhase.OriginalDeleted])(
      'cleans phase %s without restoring the replaced live tree',
      async (phase) => {
        await expectTransactionCleaned(
          await createRollbackFixture({
            phase,
            live: 'replacement',
            saved: true,
            failed: false,
            staging: false,
            liveWasIsolated: false,
          }),
          'replacement',
        );
      },
    );
  });

  it('has a recovery policy for every transaction phase', () => {
    const phases = Object.values(TransactionPhase).filter(
      (value): value is TransactionPhase => typeof value === 'number',
    );

    expect(phases.map((phase) => recoveryActionForPhase(phase))).toHaveLength(phases.length);
  });
});
