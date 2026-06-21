/**
 * @module adapters-persistence-basics.test
 * @description CRUD basics: read/write state, report persistence, path resolution,
 *              existence checks, and JSONL parsing edge cases.
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

    it('readState normalizes legacy regulated/team-ci snapshots to risk enforcement on', async () => {
      for (const mode of ['regulated', 'team-ci'] as const) {
        const state = makeProgressedState('TICKET');
        const legacy = {
          ...state,
          policySnapshot: {
            ...state.policySnapshot,
            mode,
            requestedMode: mode,
          },
        };
        delete (legacy.policySnapshot as Record<string, unknown>).enforceRiskClassification;
        delete (legacy.policySnapshot as Record<string, unknown>).allowRiskDowngradeOverride;

        await fs.mkdir(tmpDir, { recursive: true });
        await fs.writeFile(statePath(tmpDir), JSON.stringify(legacy), 'utf-8');
        const loaded = await readState(tmpDir);

        expect(loaded?.policySnapshot.enforceRiskClassification).toBe(true);
        expect(loaded?.policySnapshot.allowRiskDowngradeOverride).toBe(false);
      }
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
    it('multiple concurrent writeState calls — all succeed with lock serialization, no corruption', async () => {
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
      expect(fulfilled.length).toBe(states.length);
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
});
