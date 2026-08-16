/**
 * @module adapters-atomic-write.test
 * @description Atomic write authority: write-then-rename pattern, state/report/
 *              evidence/archive integration, EPERM/EBUSY retry with backoff,
 *              and rename failure preservation.
 *
 * Note: git adapter is integration-level (requires real git repo). Excluded from V1 tests.
 * Binding and context tests moved to adapters-binding.test.ts and adapters-context.test.ts.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as crypto from 'node:crypto';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  // Save reference for safe mock restoration in tests
  (globalThis as Record<string, unknown>).__fsActual = actual;
  return {
    ...actual,
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args)),
    writeFile: vi.fn((...args: Parameters<typeof actual.writeFile>) => actual.writeFile(...args)),
  };
});

/** Restore fs.rename to its original implementation after a failure simulation. */
function restoreRename(): void {
  const actual = (globalThis as Record<string, unknown>).__fsActual as typeof fs;
  vi.mocked(fs.rename).mockImplementation((...args: Parameters<(typeof fs)['rename']>) =>
    actual.rename(...args),
  );
}

/** Restore fs.writeFile to its original implementation after a failure simulation. */
function restoreWriteFile(): void {
  const actual = (globalThis as Record<string, unknown>).__fsActual as typeof fs;
  vi.mocked(fs.writeFile).mockImplementation((...args: Parameters<(typeof fs)['writeFile']>) =>
    actual.writeFile(...args),
  );
}

import {
  readState,
  writeState,
  writeStateAlreadyLocked,
  stateExists,
  writeReport,
  readReport,
  statePath,
  reportPath,
  auditPath,
  PersistenceError,
  isEnoent,
  atomicWrite,
} from './persistence.js';
import { appendAuditEvent, readAuditTrail } from './persistence-audit.js';
import type { SessionState } from '../state/schema.js';
import type { AuditEvent, ReviewReport } from '../state/evidence.js';
import { withTestEnv } from '../integration/test-helpers.js';
import {
  makeState,
  makeProgressedState,
  FIXED_TIME,
  FIXED_UUID,
  FIXED_SESSION_UUID,
} from '../fixtures.js';
import { materializeReviewCardArtifact } from './workspace/evidence-artifacts.js';
import { initWorkspace, archiveSession } from './workspace/index.js';
import { benchmarkSync, measureAsync, PERF_BUDGETS } from '../test-policy.js';
import { verifyChain } from '../audit/integrity.js';
import { computeCanonicalEventDigest } from '../audit/canonical-digest.js';
import { CURRENT_AUDIT_FORMAT_VERSION } from '../audit/types.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

/** Create a fresh temp directory for each test. */
async function createTmpWorktree(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'gov-test-'));
}

/** Clean up temp directory. */
async function cleanTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best effort on Windows (file locks)
  }
}

/** Create a minimal valid AuditEvent for persistence tests. */
function makeValidAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: FIXED_UUID,
    sessionId: FIXED_SESSION_UUID,
    phase: 'PLAN',
    event: 'transition:PLAN_READY',
    timestamp: FIXED_TIME,
    actor: 'machine',
    detail: { kind: 'transition', from: 'TICKET', to: 'PLAN' },
    ...overrides,
  };
}

/** Create a minimal valid ReviewReport for persistence tests. */
function makeValidReport(): ReviewReport {
  return {
    reviewKind: 'lifecycle_review',
    schemaVersion: 'flowguard-review-report.v1',
    sessionId: FIXED_SESSION_UUID,
    generatedAt: FIXED_TIME,
    phase: 'COMPLETE',
    planDigest: null,
    implDigest: null,
    validationSummary: [],
    findings: [],
    overallStatus: 'clean',
    completeness: {
      sessionId: FIXED_SESSION_UUID,
      phase: 'COMPLETE',
      policyMode: 'solo',
      overallComplete: true,
      slots: [],
      fourEyes: {
        required: false,
        satisfied: true,
        initiatedBy: 'test',
        decidedBy: null,
        detail: 'Four-eyes not required by policy',
      },
      summary: { total: 0, complete: 0, missing: 0, notYetRequired: 0, failed: 0 },
    },
  };
}

// =============================================================================
// persistence
// =============================================================================

describe('persistence', () => {
  beforeEach(async () => {
    tmpDir = await createTmpWorktree();
  });

  afterEach(async () => {
    await cleanTmpDir(tmpDir);
  });

  describe('atomicWrite', () => {
    it('HAPPY: normal write produces exact content and round-trips', async () => {
      const filePath = path.join(tmpDir, 'atomic-test.json');
      const content = JSON.stringify({ key: 'value', nested: { a: 1 } }, null, 2) + '\n';

      await atomicWrite(filePath, content);
      const written = await fs.readFile(filePath, 'utf-8');
      expect(written).toBe(content);
    });

    it('BAD: rename failure preserves original file and cleans up temp', async () => {
      const filePath = path.join(tmpDir, 'atomic-rename-fail.json');
      const original = JSON.stringify({ valid: true, version: 1 }) + '\n';

      await atomicWrite(filePath, original);

      vi.mocked(fs.rename).mockRejectedValue(
        new Error('EXDEV — simulated cross-device rename failure'),
      );

      try {
        try {
          await atomicWrite(filePath, JSON.stringify({ replaced: true }) + '\n');
        } catch (err) {
          expect(err).toBeInstanceOf(PersistenceError);
        }

        const afterFailure = await fs.readFile(filePath, 'utf-8');
        expect(afterFailure).toBe(original);

        const dir = path.dirname(filePath);
        const entries = await fs.readdir(dir);
        const tmpFiles = entries.filter((e) => e.includes('.tmp'));
        expect(tmpFiles).toHaveLength(0);
      } finally {
        restoreRename();
      }
    });

    it('EDGE: overwrites existing file atomically', async () => {
      const filePath = path.join(tmpDir, 'atomic-overwrite.json');
      const first = JSON.stringify({ n: 1 }) + '\n';
      const second = JSON.stringify({ n: 2 }) + '\n';

      await atomicWrite(filePath, first);
      await atomicWrite(filePath, second);
      const result = await fs.readFile(filePath, 'utf-8');
      expect(result).toBe(second);
    });

    it('EDGE: orphaned temp files do not affect subsequent writes', async () => {
      const filePath = path.join(tmpDir, 'atomic-orphan.json');
      const dir = path.dirname(filePath);
      const base = path.basename(filePath);
      const orphanTemp = path.join(dir, `.${base}.${crypto.randomUUID()}.tmp`);
      await fs.writeFile(orphanTemp, 'orphan', 'utf-8');

      const content = JSON.stringify({ ok: true }) + '\n';
      await atomicWrite(filePath, content);
      const result = await fs.readFile(filePath, 'utf-8');
      expect(result).toBe(content);
    });
  });

  // ── atomicWrite integration: state ──────────────────────────
  describe('atomicWrite — state', () => {
    it('writeState preserves existing state when rename fails', async () => {
      const state1 = makeState('TICKET');
      const state2 = makeProgressedState('PLAN');

      await writeState(tmpDir, state1);
      const loaded1 = await readState(tmpDir);
      expect(loaded1?.phase).toBe('TICKET');

      vi.mocked(fs.rename).mockRejectedValue(new Error('EXDEV — simulated failure'));

      try {
        try {
          await writeState(tmpDir, state2);
        } catch (err) {
          expect(err).toBeInstanceOf(PersistenceError);
        }

        const loaded2 = await readState(tmpDir);
        expect(loaded2?.phase).toBe('TICKET');
      } finally {
        restoreRename();
      }
    });
  });

  // ── atomicWrite integration: evidence/archive ───────────────
  describe('atomicWrite — evidence & archive', () => {
    it('writeReport preserves existing report when rename fails', async () => {
      const report1 = makeValidReport();
      const report2: ReviewReport = { ...makeValidReport(), overallStatus: 'issues' };

      await writeReport(tmpDir, report1);
      const loaded1 = await readReport(tmpDir);
      expect(loaded1?.overallStatus).toBe(report1.overallStatus);

      vi.mocked(fs.rename).mockRejectedValue(new Error('EXDEV — simulated failure'));

      try {
        try {
          await writeReport(tmpDir, report2);
        } catch (err) {
          expect(err).toBeInstanceOf(PersistenceError);
        }

        const loaded2 = await readReport(tmpDir);
        expect(loaded2?.overallStatus).toBe(report1.overallStatus);
      } finally {
        restoreRename();
      }
    });

    it('EVIDENCE: rename failure during materialization does not corrupt existing artifacts', async () => {
      expect.assertions(8);
      const state = makeProgressedState('PLAN');
      await writeState(tmpDir, state);

      // Phase 1: write initial artifact successfully
      const digest1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
      const r1 = await materializeReviewCardArtifact(
        tmpDir,
        'plan-review-card',
        '# Approved.',
        state,
        digest1,
      );
      expect(r1).toBeNull();

      const artifactsDir = path.join(tmpDir, 'artifacts');
      const mdPath = path.join(artifactsDir, `plan-review-card.${digest1}.md`);
      const jsonPath = path.join(artifactsDir, `plan-review-card.${digest1}.json`);
      const originalMd = await fs.readFile(mdPath, 'utf-8');
      const originalJson = await fs.readFile(jsonPath, 'utf-8');

      // Phase 2: call must return error (function catches PersistenceError internally)
      try {
        vi.mocked(fs.rename).mockRejectedValue(new Error('EXDEV — simulated failure'));

        const digest2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';
        const failedResult = await materializeReviewCardArtifact(
          tmpDir,
          'plan-review-card',
          '# Rejected.',
          state,
          digest2,
        );
        expect(failedResult).not.toBeNull();
        expect(failedResult?.code).toBe('REVIEW_CARD_ARTIFACT_WRITE_FAILED');
      } finally {
        restoreRename();
      }

      // Original artifacts intact
      const afterMd = await fs.readFile(mdPath, 'utf-8');
      expect(afterMd).toBe(originalMd);
      const afterJson = await fs.readFile(jsonPath, 'utf-8');
      expect(afterJson).toBe(originalJson);

      // No partial artifacts for the failed digest
      const newMdPath = path.join(
        artifactsDir,
        `plan-review-card.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2.md`,
      );
      const newJsonPath = path.join(
        artifactsDir,
        `plan-review-card.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2.json`,
      );
      expect(existsSync(newMdPath)).toBe(false);
      expect(existsSync(newJsonPath)).toBe(false);

      // No orphan .tmp files
      const entries = await fs.readdir(artifactsDir);
      const tmpFiles = entries.filter((e) => e.includes('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('ARCHIVE: checksum sidecar is preserved when its atomic replacement fails', async () => {
      const worktree = tmpDir;
      const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gov-archive-config-'));
      const cleanupEnv = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
      const sessionId = `archive-atomic-${Date.now()}`;
      try {
        // Write config with raw export enabled for the archive test.
        await fs.writeFile(
          path.join(configDir, 'flowguard.json'),
          JSON.stringify({
            schemaVersion: 'v1',
            archive: { redaction: { allowedModes: ['none'], allowRawExport: true } },
          }),
          'utf8',
        );
        const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
        const state = makeState('COMPLETE');
        await writeState(sessDir, {
          ...state,
          policySnapshot: { ...state.policySnapshot, mode: 'regulated' },
        });

        const archiveDir = path.join(configDir, 'workspaces', fingerprint, 'sessions', 'archive');
        const checksumPath = path.join(archiveDir, `${sessionId}.tar.gz.sha256`);
        const originalChecksum = 'a'.repeat(64) + `  ${sessionId}.tar.gz\n`;
        await fs.mkdir(archiveDir, { recursive: true });
        await fs.writeFile(checksumPath, originalChecksum, 'utf-8');

        vi.mocked(fs.rename).mockRejectedValue(new Error('EXDEV — simulated failure'));
        await expect(
          archiveSession(fingerprint, sessionId, { redactionMode: 'none', includeRaw: true }),
        ).rejects.toMatchObject({
          code: 'ARCHIVE_FAILED',
        });
        restoreRename();

        expect(existsSync(checksumPath)).toBe(true);
        expect(await fs.readFile(checksumPath, 'utf-8')).toBe(originalChecksum);

        // No orphan .tmp files remain beside the checksum sidecar.
        const entries = await fs.readdir(archiveDir);
        const tmpFiles = entries.filter((e) => e.includes('.tmp'));
        expect(tmpFiles).toHaveLength(0);
      } finally {
        restoreRename();
        cleanupEnv();
        await cleanTmpDir(configDir);
      }
    });
  });

  describe('atomicWrite — retry & errors', () => {
    beforeEach(async () => {
      await fs.mkdir(tmpDir, { recursive: true });
      vi.mocked(fs.rename).mockClear();
      vi.mocked(fs.writeFile).mockClear();
    });

    afterEach(() => {
      restoreRename();
      restoreWriteFile();
    });

    // ── EDGE ─────────────────────────────────────────────────

    it('succeeds after EPERM retries (2 failures, 3rd succeeds)', async () => {
      const filePath = path.join(tmpDir, 'retry-eperm.json');
      const content = JSON.stringify({ ok: true }) + '\n';
      vi.mocked(fs.rename).mockRejectedValueOnce(
        Object.assign(new Error('EPERM'), { code: 'EPERM' }),
      );
      vi.mocked(fs.rename).mockRejectedValueOnce(
        Object.assign(new Error('EPERM'), { code: 'EPERM' }),
      );

      await atomicWrite(filePath, content);
      const written = await fs.readFile(filePath, 'utf-8');
      expect(written).toBe(content);
      // Two rejections consumed + one real call = 3 total
      expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(3);
    });

    it('succeeds after EBUSY retry (1 failure, 2nd succeeds)', async () => {
      const filePath = path.join(tmpDir, 'retry-ebusy.json');
      const content = JSON.stringify({ ok: true }) + '\n';
      vi.mocked(fs.rename).mockRejectedValueOnce(
        Object.assign(new Error('EBUSY'), { code: 'EBUSY' }),
      );

      await atomicWrite(filePath, content);
      const written = await fs.readFile(filePath, 'utf-8');
      expect(written).toBe(content);
      expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(2);
    });

    // ── BAD ──────────────────────────────────────────────────

    it('throws WRITE_FAILED after 3 EPERM retries exhausted', async () => {
      const filePath = path.join(tmpDir, 'retry-exhaust.json');
      vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
      const original = JSON.stringify({ original: true }) + '\n';
      await fs.writeFile(filePath, original, 'utf-8');

      let caught: PersistenceError | undefined;
      try {
        await atomicWrite(filePath, JSON.stringify({ new: true }) + '\n');
      } catch (err) {
        caught = err as PersistenceError;
        expect(caught).toBeInstanceOf(PersistenceError);
        expect(caught.code).toBe('WRITE_FAILED');
      }
      expect(caught).toBeDefined();
      expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(3);
      const after = await fs.readFile(filePath, 'utf-8');
      expect(after).toBe(original);
    });

    it('throws WRITE_FAILED when writeFile fails with EACCES', async () => {
      const filePath = path.join(tmpDir, 'write-eacces.json');
      vi.mocked(fs.writeFile).mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

      let caught: unknown;
      try {
        await atomicWrite(filePath, 'content');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PersistenceError);
      expect((caught as PersistenceError).code).toBe('WRITE_FAILED');
    });

    it('throws WRITE_FAILED when writeFile fails with ENOSPC', async () => {
      const filePath = path.join(tmpDir, 'write-enospc.json');
      vi.mocked(fs.writeFile).mockRejectedValueOnce(
        Object.assign(new Error('no space'), { code: 'ENOSPC' }),
      );

      let caught: unknown;
      try {
        await atomicWrite(filePath, 'content');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PersistenceError);
      expect((caught as PersistenceError).code).toBe('WRITE_FAILED');
    });

    it('cleans up temp file after writeFile failure', async () => {
      const filePath = path.join(tmpDir, 'write-cleanup.json');
      vi.mocked(fs.writeFile).mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

      try {
        await atomicWrite(filePath, 'content');
      } catch {
        // expected
      }
      const entries = await fs.readdir(tmpDir);
      const tmpFiles = entries.filter((e) => e.startsWith('.') && e.includes('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    // ── EDGE ─────────────────────────────────────────────────

    it('does not retry non-EPERM/EBUSY errors', async () => {
      const filePath = path.join(tmpDir, 'no-retry-exdev.json');
      vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));

      await expect(atomicWrite(filePath, JSON.stringify({}) + '\n')).rejects.toThrow(
        PersistenceError,
      );
      expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(1);
    });
  });
});
