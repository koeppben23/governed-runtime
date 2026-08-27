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
import type { AuditEvent, AuditEventBody, ReviewReport } from '../state/evidence.js';
import { buildReviewReportCard } from '../presentation/review-report-card.js';
import type { CompactProofPresentation } from '../presentation/proof-model.js';
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
function makeValidAuditEvent(overrides: Partial<AuditEventBody> = {}): AuditEventBody {
  return {
    id: FIXED_UUID,
    flowguardSessionId: FIXED_SESSION_UUID,
    hostSessionId: 'ses_host_test',
    phase: 'PLAN',
    event: 'transition:PLAN_READY',
    occurredAt: FIXED_TIME,
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

    it('preserves canonical material relations across report persistence and card projection', async () => {
      const finding = {
        severity: 'major' as const,
        category: 'correctness' as const,
        message: 'The implementation omits the approved rollback step.',
        relation: {
          subjectAnchors: [
            {
              kind: 'artifact_section' as const,
              artifactKind: 'plan' as const,
              artifactDigest: 'a'.repeat(64),
              sectionPath: [
                { headingDepth: 1, siblingIndex: 1, headingText: 'Rollback procedure' },
              ],
            },
          ],
          evidenceLocations: [{ path: 'src/rollback.ts', revision: 'head' as const, line: 42 }],
        },
      };
      await writeReport(tmpDir, {
        ...makeValidReport(),
        reviewKind: 'content_review',
        reviewSubject: {
          kind: 'content',
          source: { kind: 'inline', mediaType: 'text' },
          materialDigest: 'b'.repeat(64),
          subjectDigest: 'a'.repeat(64),
          lineCount: 1,
        },
        overallStatus: 'issues',
        findings: [{ source: 'material_finding', reportSeverity: 'error', finding }],
      });
      const loaded = await readReport(tmpDir);
      expect(loaded?.findings).toEqual([
        { source: 'material_finding', reportSeverity: 'error', finding },
      ]);
      if (!loaded || loaded.findings[0]?.source !== 'material_finding') {
        throw new Error('Expected persisted material finding');
      }
      const proofSummary = {
        kind: 'evaluation',
        overallStatus: 'NOT_DECLARED',
        claimCount: 0,
        criticalCount: 0,
        criticalProvenCount: 0,
        provenCount: 0,
        contradictedCount: 0,
        blockedCount: 0,
        staleCount: 0,
        unprovenCount: 0,
        notVerifiedCount: 0,
        coverage: 'NOT_DECLARED',
        unmetCriticalClaims: [],
        otherHighlightedClaims: [],
        approval: { attestations: [] },
        decisionContext: 'completion',
      } satisfies CompactProofPresentation;
      const card = buildReviewReportCard({
        phase: 'COMPLETE',
        phaseLabel: 'Complete',
        overallStatus: 'issues',
        findings: loaded.findings,
        completeness: { overallComplete: true, fourEyes: false, total: 0, summary: '0/0 complete' },
        proofSummary,
        productNextAction: { text: 'Export.', commands: ['/export'] },
        conclusionAction: {
          invocation: '/export',
          description: 'Export.',
          visibility: 'recommended',
        },
      });
      expect(card).toContain('Plan · Rollback procedure');
      expect(card).not.toContain(finding.relation.subjectAnchors[0]!.artifactDigest);
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

    it('appendAuditEvent accepts OpenCode-style non-UUID host session IDs', async () => {
      const event = makeValidAuditEvent({
        hostSessionId: 'ses_260740c65ffe77OjxRP7z40yH8',
      });
      await appendAuditEvent(tmpDir, event);
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(skipped).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.hostSessionId).toBe('ses_260740c65ffe77OjxRP7z40yH8');
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
        expect((err as PersistenceError).code).toBe('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED');
      }
    });

    it('rejects legacy counterexampleCheckId field', async () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const json = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
      const plan = json.plan as Record<string, unknown>;
      plan.claimDeclarations = {
        flow: 'plan',
        claims: [
          {
            claimId: '00000000-0000-4000-8000-000000000001',
            statement: 'legacy',
            critical: true,
            authoritySectionId: 's1',
            expectedCheckId: 'test',
            counterexampleCheckId: 'security',
          },
        ],
      };
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(statePath(tmpDir), JSON.stringify(json), 'utf-8');
      await expect(readState(tmpDir)).rejects.toThrow(PersistenceError);
    });

    it('rejects counterexampleRequirement with mode field', async () => {
      const state = makeProgressedState('PLAN_REVIEW');
      const json = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
      const plan = json.plan as Record<string, unknown>;
      plan.claimDeclarations = {
        flow: 'plan',
        claims: [
          {
            claimId: '00000000-0000-4000-8000-000000000001',
            statement: 'with mode',
            critical: true,
            authoritySectionId: 's1',
            expectedCheckId: 'test',
            counterexampleRequirement: {
              mode: 'assertion',
              checkId: 'security',
              assertion: { providerId: 'junit', localId: 'x#y' },
            },
          },
        ],
      };
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(statePath(tmpDir), JSON.stringify(json), 'utf-8');
      await expect(readState(tmpDir)).rejects.toThrow(PersistenceError);
    });

    it('rejects assertionId in StructuredAssertionEvidence', async () => {
      const state = makeProgressedState('IMPL_REVIEW');
      const json = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
      json.implementation = {
        changedFiles: ['a.ts'],
        domainFiles: ['a.ts'],
        digest: 'impl-digest',
        executedAt: '2026-01-01T00:00:00.000Z',
      };
      json.validationAttempts = [
        {
          attemptId: '00000000-0000-4000-8000-000000000001',
          scope: 'implementation',
          implementationDigest: 'impl-digest',
          result: {
            checkId: 'security',
            passed: true,
            detail: '',
            executedAt: '2026-01-01T00:00:00.000Z',
            kind: 'security',
            command: 'run',
            exitCode: 0,
            executionMs: 5,
            outputDigest: 'a'.repeat(64),
            timedOut: false,
            outcome: 'supported',
            assertionExtraction: {
              status: 'extracted',
              attemptId: '00000000-0000-4000-8000-000000000002',
              format: 'junit_xml',
              reportDigests: ['b'.repeat(64)],
              assertions: [
                {
                  assertionId: 'junit:Test#m',
                  assertion: { providerId: 'junit', localId: 'Test#m' },
                  providerId: 'junit',
                  status: 'passed',
                  testName: 'm',
                },
              ],
              summary: {
                assertionCount: 1,
                passedCount: 1,
                failedCount: 0,
                erroredCount: 0,
                skippedCount: 0,
                suiteInfrastructureError: false,
              },
            },
          },
        },
      ];
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(statePath(tmpDir), JSON.stringify(json), 'utf-8');
      await expect(readState(tmpDir)).rejects.toThrow(PersistenceError);
    });

    it('rejects framework in StructuredAssertionEvidence', async () => {
      const state = makeProgressedState('IMPL_REVIEW');
      const json = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
      json.implementation = {
        changedFiles: ['a.ts'],
        domainFiles: ['a.ts'],
        digest: 'impl-digest',
        executedAt: '2026-01-01T00:00:00.000Z',
      };
      json.validationAttempts = [
        {
          attemptId: '00000000-0000-4000-8000-000000000001',
          scope: 'implementation',
          implementationDigest: 'impl-digest',
          result: {
            checkId: 'security',
            passed: true,
            detail: '',
            executedAt: '2026-01-01T00:00:00.000Z',
            kind: 'security',
            command: 'run',
            exitCode: 0,
            executionMs: 5,
            outputDigest: 'a'.repeat(64),
            timedOut: false,
            outcome: 'supported',
            assertionExtraction: {
              status: 'extracted',
              attemptId: '00000000-0000-4000-8000-000000000002',
              format: 'junit_xml',
              reportDigests: ['b'.repeat(64)],
              assertions: [
                {
                  framework: 'junit',
                  assertion: { providerId: 'junit', localId: 'Test#m' },
                  providerId: 'junit',
                  status: 'passed',
                  testName: 'm',
                },
              ],
              summary: {
                assertionCount: 1,
                passedCount: 1,
                failedCount: 0,
                erroredCount: 0,
                skippedCount: 0,
                suiteInfrastructureError: false,
              },
            },
          },
        },
      ];
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(statePath(tmpDir), JSON.stringify(json), 'utf-8');
      await expect(readState(tmpDir)).rejects.toThrow(PersistenceError);
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('readAuditTrail fails closed on malformed or legacy lines', async () => {
      await fs.mkdir(tmpDir, { recursive: true });
      const content = ['this is not json', ''].join('\n');
      await fs.writeFile(auditPath(tmpDir), content, 'utf-8');
      await expect(readAuditTrail(tmpDir)).rejects.toMatchObject({
        code: 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED',
      });
    });

    it('readAuditTrail fails closed on valid JSON that is not an audit-chain.v3 record', async () => {
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(auditPath(tmpDir), JSON.stringify({ invalid: 'schema' }) + '\n', 'utf-8');
      await expect(readAuditTrail(tmpDir)).rejects.toMatchObject({
        code: 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED',
      });
    });

    it('readAuditTrail reads appended v3 records', async () => {
      await fs.mkdir(tmpDir, { recursive: true });
      await appendAuditEvent(tmpDir, makeValidAuditEvent());
      await appendAuditEvent(
        tmpDir,
        makeValidAuditEvent({ id: '22222222-2222-4222-8222-222222222222' }),
      );
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(2);
      expect(skipped).toBe(0);
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
            hostSessionId: FIXED_SESSION_UUID,
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

    it('fails closed on a truncated last line (partial JSON)', async () => {
      await appendAuditEvent(tmpDir, makeValidAuditEvent());
      const raw = await fs.readFile(auditPath(tmpDir), 'utf-8');
      const content = raw + '{"id":"00000000-0000-4000-8000'; // truncated, no closing brace
      await fs.writeFile(auditPath(tmpDir), content, 'utf-8');
      await expect(readAuditTrail(tmpDir)).rejects.toMatchObject({
        code: 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED',
      });
    });

    it('ignores empty lines between valid events', async () => {
      await appendAuditEvent(tmpDir, makeValidAuditEvent({ event: 'first' }));
      await appendAuditEvent(
        tmpDir,
        makeValidAuditEvent({
          id: '11111111-1111-4111-8111-111111111111',
          event: 'second',
        }),
      );
      const raw = await fs.readFile(auditPath(tmpDir), 'utf-8');
      await fs.writeFile(auditPath(tmpDir), raw.replace('\n', '\n\n'), 'utf-8');
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(2);
      expect(skipped).toBe(0);
    });

    it('handles lines with leading and trailing whitespace', async () => {
      await appendAuditEvent(tmpDir, makeValidAuditEvent({ event: 'whitespace-test' }));
      const raw = await fs.readFile(auditPath(tmpDir), 'utf-8');
      const padded = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => `  ${line}  `)
        .join('\n');
      await fs.writeFile(auditPath(tmpDir), padded, 'utf-8');
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

    it('fails closed on valid JSON that is not an audit-chain.v3 record (array)', async () => {
      await appendAuditEvent(tmpDir, makeValidAuditEvent());
      const raw = await fs.readFile(auditPath(tmpDir), 'utf-8');
      await fs.writeFile(auditPath(tmpDir), raw + '[1,2,3]\n', 'utf-8');
      await expect(readAuditTrail(tmpDir)).rejects.toMatchObject({
        code: 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED',
      });
    });

    it('fails closed on valid JSON primitives (string, number, boolean)', async () => {
      await appendAuditEvent(tmpDir, makeValidAuditEvent());
      const raw = await fs.readFile(auditPath(tmpDir), 'utf-8');
      await fs.writeFile(auditPath(tmpDir), '"just a string"\n' + raw + '42\ntrue\n', 'utf-8');
      await expect(readAuditTrail(tmpDir)).rejects.toMatchObject({
        code: 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED',
      });
    });

    // ── EDGE ─────────────────────────────────────────────────

    it('handles UTF-8 BOM at start of file', async () => {
      await appendAuditEvent(tmpDir, makeValidAuditEvent());
      const raw = await fs.readFile(auditPath(tmpDir), 'utf-8');
      const bom = '\uFEFF';
      await fs.writeFile(auditPath(tmpDir), bom + raw, 'utf-8');
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(1);
      expect(skipped).toBe(0);
    });

    it('fails closed on mixed content with malformed and non-v3 lines', async () => {
      await appendAuditEvent(tmpDir, makeValidAuditEvent());
      const raw = await fs.readFile(auditPath(tmpDir), 'utf-8');
      const content = raw + 'not json\n{"invalid":"schema"}\n{truncated\n';
      await fs.writeFile(auditPath(tmpDir), content, 'utf-8');
      await expect(readAuditTrail(tmpDir)).rejects.toMatchObject({
        code: 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED',
      });
    });

    // ── PERF ─────────────────────────────────────────────────

    it('handles large audit trail (500 events) correctly', async () => {
      for (let i = 0; i < 500; i++) {
        const idSuffix = String(i).padStart(12, '0');
        await appendAuditEvent(
          tmpDir,
          makeValidAuditEvent({
            id: `00000000-0000-4000-8000-${idSuffix}`,
            event: `event_${i}`,
          }),
        );
      }
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(500);
      expect(skipped).toBe(0);
    });
  });
});
