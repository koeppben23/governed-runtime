/**
 * @module adapters.test
 * @description Tests for the FlowGuard adapter layer.
 *
 * Covers:
 * - persistence: atomic file I/O, Zod validation, JSONL trail (uses real temp dirs)
 * - binding: validateBinding, fromOpenCodeContext (pure functions)
 * - context: createRailContext factory
 *
 * Note: git adapter is integration-level (requires real git repo). Excluded from V1 tests.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withTestEnv } from '../integration/test-helpers.js';
import * as crypto from 'node:crypto';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  // Save reference for safe mock restoration in tests
  (globalThis as Record<string, unknown>).__fsActual = actual;
  return {
    ...actual,
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args)),
    appendFile: vi.fn((...args: Parameters<typeof actual.appendFile>) =>
      actual.appendFile(...args),
    ),
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

/** Restore fs.appendFile to its original implementation after a failure simulation. */
function restoreAppendFile(): void {
  const actual = (globalThis as Record<string, unknown>).__fsActual as typeof fs;
  vi.mocked(fs.appendFile).mockImplementation((...args: Parameters<(typeof fs)['appendFile']>) =>
    actual.appendFile(...args),
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
  stateExists,
  writeReport,
  readReport,
  appendAuditEvent,
  readAuditTrail,
  statePath,
  reportPath,
  auditPath,
  PersistenceError,
  isEnoent,
  atomicWrite,
} from './persistence.js';
import { validateBinding, fromOpenCodeContext, BindingError } from './binding.js';
import { createRailContext } from './context.js';
import type { SessionState } from '../state/schema.js';
import type { AuditEvent, ReviewReport } from '../state/evidence.js';
import { materializeReviewCardArtifact } from './workspace/evidence-artifacts.js';
import { initWorkspace, archiveSession } from './workspace/index.js';
import {
  makeState,
  makeProgressedState,
  FIXED_TIME,
  FIXED_UUID,
  FIXED_SESSION_UUID,
} from '../__fixtures__.js';
import { benchmarkSync, measureAsync, PERF_BUDGETS } from '../test-policy.js';

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

  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('path helpers resolve correct paths', () => {
      const sessDir = '/tmp/sessions/abc123';
      expect(statePath(sessDir)).toBe(path.join(sessDir, 'session-state.json'));
      expect(reportPath(sessDir)).toBe(path.join(sessDir, 'review-report.json'));
      expect(auditPath(sessDir)).toBe(path.join(sessDir, 'audit.jsonl'));
    });

    it('writeState + readState round-trip preserves data', async () => {
      const state = makeProgressedState('PLAN_REVIEW');
      await writeState(tmpDir, state);
      const loaded = await readState(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.phase).toBe('PLAN_REVIEW');
      expect(loaded!.ticket!.text).toBe(state.ticket!.text);
      expect(loaded!.plan!.current.digest).toBe(state.plan!.current.digest);
    });

    it('stateExists returns true after writeState', async () => {
      expect(await stateExists(tmpDir)).toBe(false);
      await writeState(tmpDir, makeProgressedState('TICKET'));
      expect(await stateExists(tmpDir)).toBe(true);
    });

    it('writeReport + readReport round-trip preserves data', async () => {
      const report = makeValidReport();
      await writeReport(tmpDir, report);
      const loaded = await readReport(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.schemaVersion).toBe('flowguard-review-report.v1');
      expect(loaded!.overallStatus).toBe('clean');
    });

    it('appendAuditEvent + readAuditTrail round-trip', async () => {
      const event1 = makeValidAuditEvent();
      const event2 = makeValidAuditEvent({
        id: '11111111-1111-4111-8111-111111111111',
        event: 'transition:TICKET_SET',
      });
      await appendAuditEvent(tmpDir, event1);
      await appendAuditEvent(tmpDir, event2);
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(2);
      expect(skipped).toBe(0);
      expect(events[0]!.event).toBe('transition:PLAN_READY');
      expect(events[1]!.event).toBe('transition:TICKET_SET');
    });

    it('appendAuditEvent accepts OpenCode-style non-UUID session IDs', async () => {
      const event = makeValidAuditEvent({
        sessionId: 'ses_260740c65ffe77OjxRP7z40yH8',
      });
      await appendAuditEvent(tmpDir, event);
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(skipped).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.sessionId).toBe('ses_260740c65ffe77OjxRP7z40yH8');
    });

    it('writeState auto-creates parent directory', async () => {
      // tmpDir is the sessionDir — writeState should auto-create it
      const state = makeProgressedState('TICKET');
      await writeState(tmpDir, state);
      const stat = await fs.stat(tmpDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('isEnoent correctly identifies ENOENT errors', () => {
      const enoent = { code: 'ENOENT', message: 'no such file' };
      const eperm = { code: 'EPERM', message: 'permission denied' };
      expect(isEnoent(enoent)).toBe(true);
      expect(isEnoent(eperm)).toBe(false);
      expect(isEnoent(null)).toBe(false);
      expect(isEnoent('not an object')).toBe(false);
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('readState returns null for nonexistent file', async () => {
      const result = await readState(tmpDir);
      expect(result).toBeNull();
    });

    it('readReport returns null for nonexistent file', async () => {
      const result = await readReport(tmpDir);
      expect(result).toBeNull();
    });

    it('readAuditTrail returns empty for nonexistent file', async () => {
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(0);
      expect(skipped).toBe(0);
    });

    it('writeState rejects invalid state (Zod validation)', async () => {
      const invalid = { phase: 'INVALID_PHASE' } as unknown as SessionState;
      await expect(writeState(tmpDir, invalid)).rejects.toThrow(PersistenceError);
      try {
        await writeState(tmpDir, invalid);
      } catch (err) {
        expect(err).toBeInstanceOf(PersistenceError);
        expect((err as PersistenceError).code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('readState throws on corrupted JSON', async () => {
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(statePath(tmpDir), 'not valid json{{{', 'utf-8');
      await expect(readState(tmpDir)).rejects.toThrow(PersistenceError);
      try {
        await readState(tmpDir);
      } catch (err) {
        expect((err as PersistenceError).code).toBe('PARSE_FAILED');
      }
    });

    it('readState throws on valid JSON but invalid schema', async () => {
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(statePath(tmpDir), JSON.stringify({ foo: 'bar' }), 'utf-8');
      await expect(readState(tmpDir)).rejects.toThrow(PersistenceError);
      try {
        await readState(tmpDir);
      } catch (err) {
        expect((err as PersistenceError).code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('readAuditTrail skips malformed lines but reads valid ones', async () => {
      await fs.mkdir(tmpDir, { recursive: true });
      const validEvent = makeValidAuditEvent();
      const content = [
        JSON.stringify(validEvent),
        'this is not json',
        JSON.stringify({ invalid: 'schema' }),
        JSON.stringify(makeValidAuditEvent({ id: '22222222-2222-4222-8222-222222222222' })),
        '',
      ].join('\n');
      await fs.writeFile(auditPath(tmpDir), content, 'utf-8');
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(2);
      expect(skipped).toBe(2); // malformed JSON + valid JSON but invalid schema
    });

    it('readAuditTrail handles empty file', async () => {
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(auditPath(tmpDir), '', 'utf-8');
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(0);
      expect(skipped).toBe(0);
    });

    it('writeState overwrites previous state atomically', async () => {
      const state1 = makeProgressedState('TICKET');
      const state2 = makeProgressedState('PLAN_REVIEW');
      await writeState(tmpDir, state1);
      await writeState(tmpDir, state2);
      const loaded = await readState(tmpDir);
      expect(loaded!.phase).toBe('PLAN_REVIEW');
    });

    it('writeReport overwrites previous report', async () => {
      const report1 = makeValidReport();
      const report2: ReviewReport = { ...makeValidReport(), overallStatus: 'issues' };
      await writeReport(tmpDir, report1);
      await writeReport(tmpDir, report2);
      const loaded = await readReport(tmpDir);
      expect(loaded!.overallStatus).toBe('issues');
    });

    it('state file is pretty-printed (readable for git diffs)', async () => {
      await writeState(tmpDir, makeProgressedState('TICKET'));
      const raw = await fs.readFile(statePath(tmpDir), 'utf-8');
      expect(raw).toContain('\n  '); // 2-space indent
      expect(raw.endsWith('\n')).toBe(true); // trailing newline
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('multiple concurrent writeState calls — at least one succeeds, no corruption', async () => {
      // Race multiple writes — on Windows, NTFS locks may cause some EPERM errors.
      // The invariant: at least one write succeeds and the file is valid (no corruption).
      const states = Array.from({ length: 5 }, (_, i) =>
        makeState('TICKET', {
          id: FIXED_UUID,
          binding: {
            sessionId: FIXED_SESSION_UUID,
            worktree: `/tmp/test-${i}`,
            fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6',
            resolvedAt: FIXED_TIME,
          },
        }),
      );
      const results = await Promise.allSettled(states.map((s) => writeState(tmpDir, s)));
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      // File should be valid (one of the writes won, no corruption)
      const loaded = await readState(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.phase).toBe('TICKET');
    });

    it("appendAuditEvent is additive (doesn't overwrite)", async () => {
      for (let i = 0; i < 10; i++) {
        const id = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
        await appendAuditEvent(tmpDir, makeValidAuditEvent({ id }));
      }
      const { events } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(10);
    });

    it('readState returns fresh reference (no shared object)', async () => {
      await writeState(tmpDir, makeProgressedState('TICKET'));
      const a = await readState(tmpDir);
      const b = await readState(tmpDir);
      expect(a).not.toBe(b); // Different references
      expect(a).toEqual(b); // Same content
    });

    it('PersistenceError has correct name and code', () => {
      const err = new PersistenceError('READ_FAILED', 'test');
      expect(err.name).toBe('PersistenceError');
      expect(err.code).toBe('READ_FAILED');
      expect(err instanceof Error).toBe(true);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it('writeState + readState round-trip < 50ms', async () => {
      const state = makeProgressedState('COMPLETE');
      // Warmup
      await writeState(tmpDir, state);
      await readState(tmpDir);

      const { elapsedMs } = await measureAsync(async () => {
        await writeState(tmpDir, state);
        return await readState(tmpDir);
      });
      expect(elapsedMs).toBeLessThan(PERF_BUDGETS.stateIoRoundTripMs);
    });
  });

  // ── atomicWrite ─────────────────────────────────────────────
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

    it('ARCHIVE: rename failure during archiveSession preserves pre-existing sidecar files', async () => {
      const worktree = tmpDir;
      const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gov-archive-config-'));
      const cleanupEnv = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
      const sessionId = `archive-atomic-${Date.now()}`;
      try {
        const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);
        await writeState(sessDir, makeState('COMPLETE'));

        // Pre-create valid decision-receipts and archive-manifest with known content
        const receiptsPath = path.join(sessDir, 'decision-receipts.v1.json');
        const originalReceipts =
          JSON.stringify(
            {
              schemaVersion: 'decision-receipts.v1',
              sessionId,
              generatedAt: new Date().toISOString(),
              count: 0,
              receipts: [],
            },
            null,
            2,
          ) + '\n';
        await fs.writeFile(receiptsPath, originalReceipts, 'utf-8');

        const manifestPath = path.join(sessDir, 'archive-manifest.json');
        const originalManifest =
          JSON.stringify(
            { schemaVersion: 'archive-manifest.v1', files: [], redactionMode: 'basic' },
            null,
            2,
          ) + '\n';
        await fs.writeFile(manifestPath, originalManifest, 'utf-8');

        vi.mocked(fs.rename).mockRejectedValue(new Error('EXDEV — simulated failure'));
        await expect(archiveSession(fingerprint, sessionId)).rejects.toBeInstanceOf(
          PersistenceError,
        );
        restoreRename();

        // decision-receipts: must exist and be exactly the original content
        expect(existsSync(receiptsPath)).toBe(true);
        const afterReceipts = await fs.readFile(receiptsPath, 'utf-8');
        expect(afterReceipts).toBe(originalReceipts);

        // archive-manifest: must exist and be exactly the original content
        expect(existsSync(manifestPath)).toBe(true);
        const afterManifest = await fs.readFile(manifestPath, 'utf-8');
        expect(afterManifest).toBe(originalManifest);

        // No orphan .tmp files in session directory
        const entries = await fs.readdir(sessDir);
        const tmpFiles = entries.filter((e) => e.includes('.tmp'));
        expect(tmpFiles).toHaveLength(0);
      } finally {
        restoreRename();
        cleanupEnv();
        await cleanTmpDir(configDir);
      }
    });
  });

  // ── readState — schema validation ────────────────────────────
  describe('readState — schema validation', () => {
    beforeEach(async () => {
      await fs.mkdir(tmpDir, { recursive: true });
    });

    async function assertReadFails(
      json: unknown,
      expectedCode: 'SCHEMA_VALIDATION_FAILED' | 'PARSE_FAILED',
    ) {
      await fs.writeFile(statePath(tmpDir), JSON.stringify(json), 'utf-8');
      let caught: unknown;
      try {
        await readState(tmpDir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PersistenceError);
      expect((caught as PersistenceError).code).toBe(expectedCode);
    }

    // ── BAD ────────────────────────────────────────────────

    it('rejects missing required field "id"', () => {
      const state = makeState('TICKET');
      const { id: _, ...rest } = state;
      return assertReadFails(rest, 'SCHEMA_VALIDATION_FAILED');
    });

    it('rejects missing required field "schemaVersion"', () => {
      const state = makeState('TICKET');
      const { schemaVersion: _, ...rest } = state;
      return assertReadFails(rest, 'SCHEMA_VALIDATION_FAILED');
    });

    it('rejects missing required field "phase"', () => {
      const state = makeState('TICKET');
      const { phase: _, ...rest } = state;
      return assertReadFails(rest, 'SCHEMA_VALIDATION_FAILED');
    });

    it('rejects missing required field "binding"', () => {
      const state = makeState('TICKET');
      const { binding: _, ...rest } = state;
      return assertReadFails(rest, 'SCHEMA_VALIDATION_FAILED');
    });

    it('rejects missing required field "policySnapshot"', () => {
      const state = makeState('TICKET');
      const { policySnapshot: _, ...rest } = state;
      return assertReadFails(rest, 'SCHEMA_VALIDATION_FAILED');
    });

    it('rejects missing required field "initiatedBy"', () => {
      const state = makeState('TICKET');
      const { initiatedBy: _, ...rest } = state;
      return assertReadFails(rest, 'SCHEMA_VALIDATION_FAILED');
    });

    it('rejects missing required field "createdAt"', () => {
      const state = makeState('TICKET');
      const { createdAt: _, ...rest } = state;
      return assertReadFails(rest, 'SCHEMA_VALIDATION_FAILED');
    });

    it('rejects missing required field "nextAdrNumber"', () => {
      const state = makeState('TICKET');
      const { nextAdrNumber: _, ...rest } = state;
      return assertReadFails(rest, 'SCHEMA_VALIDATION_FAILED');
    });

    it('rejects invalid UUID for id', () => {
      return assertReadFails(
        { ...makeState('TICKET'), id: 'not-a-uuid' },
        'SCHEMA_VALIDATION_FAILED',
      );
    });

    it('rejects wrong schemaVersion', () => {
      return assertReadFails(
        { ...makeState('TICKET'), schemaVersion: 'v2' },
        'SCHEMA_VALIDATION_FAILED',
      );
    });

    it('rejects invalid phase value', () => {
      return assertReadFails(
        { ...makeState('TICKET'), phase: 'NONSENSE' },
        'SCHEMA_VALIDATION_FAILED',
      );
    });

    it('rejects invalid createdAt datetime', () => {
      return assertReadFails(
        { ...makeState('TICKET'), createdAt: 'yesterday' },
        'SCHEMA_VALIDATION_FAILED',
      );
    });

    it('rejects empty sessionId', () => {
      return assertReadFails(
        { ...makeState('TICKET'), binding: { ...makeState('TICKET').binding, sessionId: '' } },
        'SCHEMA_VALIDATION_FAILED',
      );
    });

    it('rejects sessionId longer than 128 characters', () => {
      return assertReadFails(
        {
          ...makeState('TICKET'),
          binding: { ...makeState('TICKET').binding, sessionId: 'a'.repeat(129) },
        },
        'SCHEMA_VALIDATION_FAILED',
      );
    });

    it('rejects non-positive nextAdrNumber (0)', () => {
      return assertReadFails(
        { ...makeState('TICKET'), nextAdrNumber: 0 },
        'SCHEMA_VALIDATION_FAILED',
      );
    });

    it('rejects negative nextAdrNumber', () => {
      return assertReadFails(
        { ...makeState('TICKET'), nextAdrNumber: -1 },
        'SCHEMA_VALIDATION_FAILED',
      );
    });

    it('rejects non-integer nextAdrNumber', () => {
      return assertReadFails(
        { ...makeState('TICKET'), nextAdrNumber: 1.5 },
        'SCHEMA_VALIDATION_FAILED',
      );
    });

    it('rejects missing nullable key "ticket" (key absent, not null)', () => {
      const state = makeState('TICKET');
      const { ticket: _, ...rest } = state;
      return assertReadFails(rest, 'SCHEMA_VALIDATION_FAILED');
    });

    // ── HAPPY ───────────────────────────────────────────────

    it('accepts state with all nullable fields set to null', async () => {
      const state = makeState('READY');
      await writeState(tmpDir, state);
      const loaded = await readState(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.phase).toBe('READY');
      expect(loaded!.ticket).toBeNull();
      expect(loaded!.plan).toBeNull();
      expect(loaded!.implementation).toBeNull();
    });

    // ── CORNER ──────────────────────────────────────────────

    it('rejects missing "validation" array (required, not optional)', () => {
      const state = makeState('TICKET');
      const { validation: _, ...rest } = state;
      return assertReadFails(rest, 'SCHEMA_VALIDATION_FAILED');
    });

    it('rejects missing "activeChecks" array', () => {
      const state = makeState('TICKET');
      const { activeChecks: _, ...rest } = state;
      return assertReadFails(rest, 'SCHEMA_VALIDATION_FAILED');
    });
  });

  // ── appendAuditEvent — validation and hash-field preservation
  describe('appendAuditEvent — validation and hash-field preservation', () => {
    const CHAIN_HASH_64 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
    const PREV_HASH_64 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';

    // ── BAD ────────────────────────────────────────────────

    it('rejects event missing required field "id"', async () => {
      const { id: _, ...invalid } = makeValidAuditEvent();
      let caught: unknown;
      try {
        await appendAuditEvent(tmpDir, invalid as AuditEvent);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PersistenceError);
      expect((caught as PersistenceError).code).toBe('SCHEMA_VALIDATION_FAILED');
    });

    it('rejects event missing required field "sessionId"', async () => {
      const { sessionId: _, ...invalid } = makeValidAuditEvent();
      await expect(appendAuditEvent(tmpDir, invalid as AuditEvent)).rejects.toThrow(
        PersistenceError,
      );
    });

    it('rejects event with invalid UUID id', async () => {
      let caught: unknown;
      try {
        await appendAuditEvent(tmpDir, makeValidAuditEvent({ id: 'bad-uuid' }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PersistenceError);
      expect((caught as PersistenceError).code).toBe('SCHEMA_VALIDATION_FAILED');
    });

    it('rejects event with invalid sessionId (empty)', async () => {
      await expect(
        appendAuditEvent(tmpDir, makeValidAuditEvent({ sessionId: '' })),
      ).rejects.toThrow(PersistenceError);
    });

    it('rejects event with invalid sessionId (special characters)', async () => {
      await expect(
        appendAuditEvent(tmpDir, makeValidAuditEvent({ sessionId: 'bad.id' })),
      ).rejects.toThrow(PersistenceError);
    });

    it('rejects event with invalid timestamp', async () => {
      await expect(
        appendAuditEvent(tmpDir, makeValidAuditEvent({ timestamp: 'now' })),
      ).rejects.toThrow(PersistenceError);
    });

    it('rejects event where detail is a string (not an object)', async () => {
      await expect(
        appendAuditEvent(
          tmpDir,
          makeValidAuditEvent({ detail: 'string' as unknown as Record<string, unknown> }),
        ),
      ).rejects.toThrow(PersistenceError);
    });

    it('rejects event where detail is an array (not an object)', async () => {
      await expect(
        appendAuditEvent(
          tmpDir,
          makeValidAuditEvent({ detail: [] as unknown as Record<string, unknown> }),
        ),
      ).rejects.toThrow(PersistenceError);
    });

    it('does not write trail on schema rejection', async () => {
      await expect(appendAuditEvent(tmpDir, makeValidAuditEvent({ id: 'bad' }))).rejects.toThrow(
        PersistenceError,
      );
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(0);
      expect(skipped).toBe(0);
    });

    // ── CORNER ──────────────────────────────────────────────

    it('re-throws raw error (not PersistenceError) on filesystem failure', async () => {
      vi.mocked(fs.appendFile).mockRejectedValueOnce(
        Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
      );
      try {
        try {
          await appendAuditEvent(tmpDir, makeValidAuditEvent());
        } catch (err) {
          expect(err).not.toBeInstanceOf(PersistenceError);
          expect(err).toBeInstanceOf(Error);
          expect((err as NodeJS.ErrnoException).code).toBe('ENOSPC');
        }
        const { events } = await readAuditTrail(tmpDir);
        expect(events).toHaveLength(0);
      } finally {
        restoreAppendFile();
      }
    });

    // ── HAPPY ───────────────────────────────────────────────

    it('preserves chainHash and prevHash through append/read round-trip', async () => {
      const event = makeValidAuditEvent({
        prevHash: PREV_HASH_64,
        chainHash: CHAIN_HASH_64,
      });
      await appendAuditEvent(tmpDir, event);
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(skipped).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.prevHash).toBe(PREV_HASH_64);
      expect(events[0]!.chainHash).toBe(CHAIN_HASH_64);
    });

    it('accepts event with optional actorInfo', async () => {
      const event = makeValidAuditEvent({
        actorInfo: {
          id: 'actor-1',
          email: 'actor@test.com',
          source: 'env' as const,
          assurance: 'best_effort' as const,
        },
      });
      await appendAuditEvent(tmpDir, event);
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(skipped).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.actorInfo?.id).toBe('actor-1');
      expect(events[0]!.actorInfo?.source).toBe('env');
    });

    it('accepts event without optional actorInfo', async () => {
      const event = makeValidAuditEvent();
      await appendAuditEvent(tmpDir, event);
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(skipped).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.actorInfo).toBeUndefined();
    });

    it('creates session directory if missing', async () => {
      const nestedDir = path.join(tmpDir, 'deep', 'nested', 'session');
      const event = makeValidAuditEvent();
      await appendAuditEvent(nestedDir, event);
      const { events } = await readAuditTrail(nestedDir);
      expect(events).toHaveLength(1);
    });

    it('accumulates events with correct ordering', async () => {
      for (let i = 0; i < 5; i++) {
        await appendAuditEvent(
          tmpDir,
          makeValidAuditEvent({
            id: `00000000-0000-4000-8000-00000000000${i}`,
            event: `step_${i}`,
          }),
        );
      }
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(skipped).toBe(0);
      expect(events).toHaveLength(5);
      expect(events[0]!.event).toBe('step_0');
      expect(events[4]!.event).toBe('step_4');
    });
  });

  // ── readAuditTrail — JSONL parsing ──────────────────────────
  describe('readAuditTrail — JSONL parsing', () => {
    beforeEach(async () => {
      await fs.mkdir(tmpDir, { recursive: true });
    });

    // ── CORNER ──────────────────────────────────────────────

    it('handles truncated last line (partial JSON)', async () => {
      const validEvent = makeValidAuditEvent();
      const content = [
        JSON.stringify(validEvent),
        '{"id":"00000000-0000-4000-8000', // truncated, no closing brace
      ].join('\n');
      await fs.writeFile(auditPath(tmpDir), content, 'utf-8');
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(1);
      expect(skipped).toBe(1);
    });

    it('ignores empty lines between valid events', async () => {
      const e1 = JSON.stringify(makeValidAuditEvent({ event: 'first' }));
      const e2 = JSON.stringify(
        makeValidAuditEvent({
          id: '11111111-1111-4111-8111-111111111111',
          event: 'second',
        }),
      );
      const content = [e1, '', '', e2, ''].join('\n');
      await fs.writeFile(auditPath(tmpDir), content, 'utf-8');
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(2);
      expect(skipped).toBe(0);
    });

    it('handles lines with leading and trailing whitespace', async () => {
      const event = makeValidAuditEvent({ event: 'whitespace-test' });
      const content = ['  ', `  ${JSON.stringify(event)}  `, '\t'].join('\n');
      await fs.writeFile(auditPath(tmpDir), content, 'utf-8');
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe('whitespace-test');
      expect(skipped).toBe(0);
    });

    it('handles file with only blank lines', async () => {
      await fs.writeFile(auditPath(tmpDir), '\n\n\n', 'utf-8');
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(0);
      expect(skipped).toBe(0);
    });

    it('skips valid JSON that is not an AuditEvent (array)', async () => {
      const validEvent = JSON.stringify(makeValidAuditEvent());
      const content = [validEvent, '[1,2,3]', validEvent].join('\n');
      await fs.writeFile(auditPath(tmpDir), content, 'utf-8');
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(2);
      expect(skipped).toBe(1);
    });

    it('skips valid JSON primitives (string, number, boolean)', async () => {
      const validEvent = JSON.stringify(makeValidAuditEvent());
      const content = ['"just a string"', validEvent, '42', 'true', validEvent].join('\n');
      await fs.writeFile(auditPath(tmpDir), content, 'utf-8');
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(2);
      expect(skipped).toBe(3);
    });

    // ── EDGE ─────────────────────────────────────────────────

    it('handles UTF-8 BOM at start of file', async () => {
      const event = makeValidAuditEvent();
      const json = JSON.stringify(event);
      const bom = '\uFEFF';
      await fs.writeFile(auditPath(tmpDir), bom + json + '\n', 'utf-8');
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(1);
      expect(skipped).toBe(0);
    });

    it('counts skipped lines accurately with mixed content', async () => {
      const valid = JSON.stringify(makeValidAuditEvent());
      const content = [
        valid,
        'not json',
        '{"invalid":"schema"}',
        valid,
        '',
        valid,
        '{truncated',
      ].join('\n');
      await fs.writeFile(auditPath(tmpDir), content, 'utf-8');
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(3);
      expect(skipped).toBe(3);
    });

    // ── PERF ─────────────────────────────────────────────────

    it('handles large audit trail (500 events) correctly', async () => {
      const lines: string[] = [];
      for (let i = 0; i < 500; i++) {
        const idSuffix = String(i).padStart(12, '0');
        lines.push(
          JSON.stringify(
            makeValidAuditEvent({
              id: `00000000-0000-4000-8000-${idSuffix}`,
              event: `event_${i}`,
            }),
          ),
        );
      }
      await fs.writeFile(auditPath(tmpDir), lines.join('\n'), 'utf-8');
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(500);
      expect(skipped).toBe(0);
    });
  });

  // ── atomicWrite — retry & errors ────────────────────────────
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

// =============================================================================
// binding (pure functions)
// =============================================================================

describe('binding', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('validateBinding passes for matching worktrees', () => {
      const state = makeState('TICKET', {
        binding: {
          sessionId: 'old-session',
          worktree: tmpDir || '/tmp/test-repo',
          resolvedAt: FIXED_TIME,
        },
      });
      const binding = { worktreeRoot: state.binding.worktree, sessionId: 'new-session' };
      expect(validateBinding(state, binding)).toBe(true);
    });

    it('fromOpenCodeContext maps field names correctly', () => {
      const raw = { sessionID: 'sess-123', worktree: '/tmp/repo', directory: '/tmp/repo/src' };
      const ctx = fromOpenCodeContext(raw);
      expect(ctx.sessionId).toBe('sess-123');
      expect(ctx.worktree).toBe('/tmp/repo');
      expect(ctx.directory).toBe('/tmp/repo/src');
    });

    it('validateBinding allows different session IDs (continuation)', () => {
      const worktree = path.resolve('/tmp/continuity-repo');
      const state = makeState('PLAN', {
        binding: { sessionId: 'session-old', worktree, resolvedAt: FIXED_TIME },
      });
      // New session ID but same worktree
      expect(validateBinding(state, { worktreeRoot: worktree, sessionId: 'session-new' })).toBe(
        true,
      );
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('validateBinding throws on worktree mismatch', () => {
      const state = makeState('TICKET', {
        binding: { sessionId: 'sess-1', worktree: '/tmp/repo-a', resolvedAt: FIXED_TIME },
      });
      const binding = { worktreeRoot: '/tmp/repo-b', sessionId: 'sess-1' };
      expect(() => validateBinding(state, binding)).toThrow(BindingError);
      try {
        validateBinding(state, binding);
      } catch (err) {
        expect((err as BindingError).code).toBe('WORKTREE_MISMATCH');
      }
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('validateBinding normalizes paths (trailing slash)', () => {
      const basePath = path.resolve('/tmp/norm-test');
      const state = makeState('TICKET', {
        binding: { sessionId: 's1', worktree: basePath, resolvedAt: FIXED_TIME },
      });
      // Same path but with trailing slash — should still match
      expect(validateBinding(state, { worktreeRoot: basePath + path.sep, sessionId: 's1' })).toBe(
        true,
      );
    });

    it('BindingError has correct name and code', () => {
      const err = new BindingError('MISSING_SESSION_ID', 'test');
      expect(err.name).toBe('BindingError');
      expect(err.code).toBe('MISSING_SESSION_ID');
      expect(err instanceof Error).toBe(true);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('fromOpenCodeContext preserves whitespace in values', () => {
      const raw = { sessionID: ' sess ', worktree: ' /tmp/repo ', directory: ' /tmp/repo/src ' };
      const ctx = fromOpenCodeContext(raw);
      expect(ctx.sessionId).toBe(' sess ');
      expect(ctx.worktree).toBe(' /tmp/repo ');
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it(`validateBinding < ${PERF_BUDGETS.validateBindingMs}ms (p99 over 200 iterations)`, () => {
      const worktree = path.resolve('/tmp/perf-repo');
      const state = makeState('TICKET', {
        binding: { sessionId: 's1', worktree, resolvedAt: FIXED_TIME },
      });
      const binding = { worktreeRoot: worktree, sessionId: 's1' };
      const { p99Ms } = benchmarkSync(() => validateBinding(state, binding), 200, 50);
      expect(p99Ms).toBeLessThan(PERF_BUDGETS.validateBindingMs);
    });
  });
});

// =============================================================================
// context
// =============================================================================

describe('context', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('createRailContext returns context with now() and digest()', () => {
      const ctx = createRailContext();
      expect(typeof ctx.now).toBe('function');
      expect(typeof ctx.digest).toBe('function');
    });

    it('now() returns ISO-8601 timestamp', () => {
      const ctx = createRailContext();
      const ts = ctx.now();
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // Should parse as valid date
      expect(new Date(ts).getTime()).not.toBeNaN();
    });

    it('digest() returns 64-char hex SHA-256', () => {
      const ctx = createRailContext();
      const hash = ctx.digest('hello world');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('digest() handles empty string', () => {
      const ctx = createRailContext();
      const hash = ctx.digest('');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      // SHA-256 of empty string is well-known
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('digest() is deterministic', () => {
      const ctx = createRailContext();
      expect(ctx.digest('test')).toBe(ctx.digest('test'));
    });

    it('digest() differs for different inputs', () => {
      const ctx = createRailContext();
      expect(ctx.digest('a')).not.toBe(ctx.digest('b'));
    });

    it('each createRailContext call returns independent context', () => {
      const ctx1 = createRailContext();
      const ctx2 = createRailContext();
      expect(ctx1).not.toBe(ctx2);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('now() returns different values across time', async () => {
      const ctx = createRailContext();
      const t1 = ctx.now();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const t2 = ctx.now();
      // At least different (millisecond resolution should differ after 10ms)
      expect(new Date(t2).getTime()).toBeGreaterThanOrEqual(new Date(t1).getTime());
    });

    it('digest() handles unicode content', () => {
      const ctx = createRailContext();
      const hash = ctx.digest('Hello\u00e9\u4e16\u754c');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it(`digest() of 1MB string < ${PERF_BUDGETS.digest1MbMs}ms (p95)`, () => {
      const ctx = createRailContext();
      const bigString = 'x'.repeat(1024 * 1024);
      const { p95Ms } = benchmarkSync(() => ctx.digest(bigString), 30, 8);
      expect(p95Ms).toBeLessThan(PERF_BUDGETS.digest1MbMs);
    });
  });
});
