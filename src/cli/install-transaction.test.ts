import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recoverOrAbort,
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

describe('recoverOrAbort', () => {
  it.each(RECOVERY_CASES)(
    'recovers $name',
    async ({ phase, live, saved, staging, hadOriginal }) => {
      testDir = await mkdtemp(join(tmpdir(), 'flowguard-install-recovery-'));
      const transactionId = 'recovery-test';
      const liveModulesPath = join(testDir, 'node_modules');
      const stagingRoot = join(testDir, `node_modules.install.${transactionId}`);
      const stagingModules = join(stagingRoot, 'node_modules');
      const savedPath = join(testDir, `node_modules.saved.${transactionId}`);
      const journalPath = join(testDir, `.flowguard-dependency-transaction.${transactionId}.json`);
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
