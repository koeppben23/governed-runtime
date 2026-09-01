/**
 * @module adapters-schema-audit.test
 * @description Schema-audit authority: SessionState Zod validation (21 field-level
 *              tests), AuditEvent validation, hash-chain integrity, TSA timestamp
 *              verification, and canonical digest computation.
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

  describe('readState — schema validation', () => {
    beforeEach(async () => {
      await fs.mkdir(tmpDir, { recursive: true });
    });

    async function assertReadFails(
      json: unknown,
      expectedCode: 'SCHEMA_VALIDATION_FAILED' | 'PARSE_FAILED' | 'SESSION_STATE_INCOMPATIBLE',
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
      return assertReadFails(rest, 'SESSION_STATE_INCOMPATIBLE');
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
        { ...makeState('TICKET'), schemaVersion: 'v1' },
        'SESSION_STATE_INCOMPATIBLE',
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
        {
          ...makeState('TICKET'),
          binding: { ...makeState('TICKET').binding, hostSessionId: '' },
        },
        'SCHEMA_VALIDATION_FAILED',
      );
    });

    it('rejects sessionId longer than 128 characters', () => {
      return assertReadFails(
        {
          ...makeState('TICKET'),
          binding: { ...makeState('TICKET').binding, hostSessionId: 'a'.repeat(129) },
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

    it('rejects event missing required field "flowguardSessionId"', async () => {
      const { flowguardSessionId: _, ...invalid } = makeValidAuditEvent();
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

    it('rejects event with invalid flowguardSessionId (empty)', async () => {
      await expect(
        appendAuditEvent(tmpDir, makeValidAuditEvent({ flowguardSessionId: '' })),
      ).rejects.toThrow(PersistenceError);
    });

    it('rejects event with invalid flowguardSessionId (non-UUID)', async () => {
      await expect(
        appendAuditEvent(tmpDir, makeValidAuditEvent({ flowguardSessionId: 'bad.id' })),
      ).rejects.toThrow(PersistenceError);
    });

    it('rejects event with invalid occurredAt', async () => {
      await expect(
        appendAuditEvent(tmpDir, makeValidAuditEvent({ occurredAt: 'now' })),
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

    it('recovers a dead-process audit lock before appending', async () => {
      const lockPath = path.join(tmpDir, 'audit.jsonl.lock');
      await fs.writeFile(lockPath, 'pid=999999999\ntoken=dead-token\n', 'utf-8');

      await appendAuditEvent(tmpDir, makeValidAuditEvent());

      const { events } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(1);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('re-throws raw error and preserves existing trail on atomic rename failure', async () => {
      await appendAuditEvent(tmpDir, makeValidAuditEvent({ id: crypto.randomUUID() }));
      vi.mocked(fs.rename).mockRejectedValueOnce(
        Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
      );
      try {
        try {
          await appendAuditEvent(tmpDir, makeValidAuditEvent({ id: crypto.randomUUID() }));
        } catch (err) {
          expect(err).not.toBeInstanceOf(PersistenceError);
          expect(err).toBeInstanceOf(Error);
          expect((err as NodeJS.ErrnoException).code).toBe('ENOSPC');
        }
        const { events } = await readAuditTrail(tmpDir);
        expect(events).toHaveLength(1);
      } finally {
        restoreRename();
      }
    });

    it('retries transient Windows rename failures without losing the audit trail', async () => {
      await appendAuditEvent(tmpDir, makeValidAuditEvent({ id: crypto.randomUUID() }));
      const rename = vi.mocked(fs.rename);
      rename.mockClear();
      rename
        .mockRejectedValueOnce(Object.assign(new Error('file locked'), { code: 'EPERM' }))
        .mockRejectedValueOnce(Object.assign(new Error('file busy'), { code: 'EBUSY' }));

      try {
        await appendAuditEvent(tmpDir, makeValidAuditEvent({ id: crypto.randomUUID() }));
        expect(rename).toHaveBeenCalledTimes(3);
        const { events, skipped } = await readAuditTrail(tmpDir);
        expect(skipped).toBe(0);
        expect(events).toHaveLength(2);
        expect(verifyChain(events, { strict: true }).valid).toBe(true);
      } finally {
        restoreRename();
      }
    });

    // ── HAPPY ───────────────────────────────────────────────

    it('computes chainHash and prevHash under the append lock', async () => {
      const event = makeValidAuditEvent();
      await appendAuditEvent(tmpDir, event);
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(skipped).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.prevHash).toBe('genesis');
      expect(events[0]!.chainHash).not.toBe(CHAIN_HASH_64);
      expect(verifyChain(events, { strict: true }).valid).toBe(true);
    });

    it('serializes concurrent chained audit appends without lost updates or chain forks', async () => {
      const inputs = Array.from({ length: 12 }, () =>
        makeValidAuditEvent({ id: crypto.randomUUID() }),
      );

      await Promise.all(inputs.map((event) => appendAuditEvent(tmpDir, event)));

      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(skipped).toBe(0);
      expect(events).toHaveLength(inputs.length);
      expect(new Set(events.map((event) => event.id)).size).toBe(inputs.length);
      expect(verifyChain(events, { strict: true }).valid).toBe(true);
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.prevHash).toBe(events[i - 1]!.chainHash);
      }
    });

    it('concurrent chained events with TSA timestampEvidence remain strict-timestamp-verifiable', async () => {
      const inputs = Array.from({ length: 8 }, (_, idx) => {
        const event = makeValidAuditEvent({
          id: crypto.randomUUID(),
          event: `transition:STEP_${idx}`,
        }) as AuditEvent & Record<string, unknown>;
        const canonicalDigest = computeCanonicalEventDigest({
          ...event,
          auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
        } as Record<string, unknown>);
        const withTSA = {
          ...event,
          semanticEventDigest: canonicalDigest,
          timestampEvidence: {
            status: 'tsa_stamped' as const,
            source: 'tsa' as const,
            resolvedAt: new Date(Date.now() + idx * 1000).toISOString(),
            tsa: {
              tokenDerBase64: 'dummy',
              receivedAt: new Date(Date.now() + idx * 1000).toISOString(),
              messageImprint: canonicalDigest,
              digestAlgorithm: 'sha256' as const,
              verificationStatus: 'unchecked' as const,
            },
          },
        };
        return withTSA as unknown as AuditEvent;
      });

      await Promise.all(inputs.map((event) => appendAuditEvent(tmpDir, event)));

      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(skipped).toBe(0);
      expect(events).toHaveLength(inputs.length);
      expect(verifyChain(events, { strict: true }).valid).toBe(true);
      const tsResult = verifyChain(events, { strict: true, strictTimestamps: true });
      expect(tsResult.valid).toBe(false);
      expect(tsResult.reason).toBe('TOKEN_VERIFICATION_REQUIRED');
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.prevHash).toBe(events[i - 1]!.chainHash);
      }
    });

    it('legacy v1 TSA events (canonical digest includes prevHash) fail closed in strict timestamp verification after lock reappends', async () => {
      // Simulate a v1 TSA event: canonicalEventDigest computed WITH prevHash.
      // After appendAuditEvent recomputes prevHash under the lock, strict timestamp
      // verification recomputes the v2 digest and rejects the stale v1 imprint.
      const event = makeValidAuditEvent() as AuditEvent & Record<string, unknown>;
      const stripped = { ...event } as Record<string, unknown>;
      delete stripped.chainHash;
      delete stripped.prevHash;
      delete stripped.timestampEvidence;
      delete stripped.semanticEventDigest;
      const bodyWithOldPrev: Record<string, unknown> = {
        ...stripped,
        prevHash: 'old-prev-hash-64-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      };
      const sortedKeys = Object.keys(bodyWithOldPrev).sort();
      const canonical: Record<string, unknown> = {};
      for (const key of sortedKeys) canonical[key] = bodyWithOldPrev[key];
      const v1Digest = crypto
        .createHash('sha256')
        .update(JSON.stringify(canonical), 'utf-8')
        .digest('hex');

      const withTsa = {
        ...event,
        semanticEventDigest: v1Digest,
        timestampEvidence: {
          status: 'tsa_stamped' as const,
          source: 'tsa' as const,
          resolvedAt: '2026-01-01T00:00:00.000Z',
          tsa: {
            tokenDerBase64: 'v1-legacy',
            receivedAt: '2026-01-01T00:00:01.000Z',
            messageImprint: v1Digest,
            digestAlgorithm: 'sha256' as const,
            verificationStatus: 'unchecked' as const,
          },
        },
      };
      await appendAuditEvent(tmpDir, withTsa as unknown as AuditEvent);
      const { events } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(1);
      const result = verifyChain(events, { strict: true, strictTimestamps: true });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('TOKEN_VERIFICATION_REQUIRED');
    });

    it('refuses to append when existing audit trail has unparseable lines', async () => {
      const auditFilePath = auditPath(tmpDir);
      await fs.mkdir(path.dirname(auditFilePath), { recursive: true });
      await fs.writeFile(auditFilePath, '{invalid-json\n', 'utf-8');

      const event = makeValidAuditEvent({ id: crypto.randomUUID() });
      await expect(appendAuditEvent(tmpDir, event)).rejects.toThrow(/not valid JSONL|LEGACY/i);

      // Original corrupt trail is preserved, no partial append.
      const raw = await fs.readFile(auditFilePath, 'utf-8');
      expect(raw).toContain('{invalid-json');
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

  describe('appendAuditEvent — exactly-once on re-delivery', () => {
    const FORGED_CHAIN_HASH = 'a'.repeat(64);
    const FORGED_PREV_HASH = 'b'.repeat(64);

    // An event id is a commit identity. A crash between append and
    // acknowledgement re-delivers the SAME raw producer body — which carries
    // no positional fields and no auditFormatVersion. The writer must return
    // the already-persisted record rather than fail the retry closed.

    it('returns the persisted record when the identical raw body is re-delivered', async () => {
      const body = makeValidAuditEvent();
      const first = await appendAuditEvent(tmpDir, body);

      const second = await appendAuditEvent(tmpDir, body);

      expect(second).toEqual(first);
      const { events, skipped } = await readAuditTrail(tmpDir);
      expect(skipped).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.auditSequence).toBe(1);
    });

    it('returns the persisted record when a re-delivery carries forged positional fields', async () => {
      const body = makeValidAuditEvent();
      const first = await appendAuditEvent(tmpDir, body);

      // Producer-supplied positional/authority values are never accepted, so
      // they must not influence the exactly-once comparison either.
      const forged = {
        ...body,
        auditFormatVersion: 'audit-chain.v1',
        auditSequence: 99,
        recordedAt: '2020-01-01T00:00:00.000Z',
        semanticEventDigest: 'f'.repeat(64),
        prevHash: FORGED_PREV_HASH,
        chainHash: FORGED_CHAIN_HASH,
      } as unknown as AuditEventBody;

      const second = await appendAuditEvent(tmpDir, forged);

      expect(second).toEqual(first);
      const { events } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(1);
      expect(events[0]!.auditSequence).toBe(1);
    });

    it('fails closed when the same id is re-delivered with different semantics', async () => {
      const body = makeValidAuditEvent();
      await appendAuditEvent(tmpDir, body);

      let caught: unknown;
      try {
        await appendAuditEvent(tmpDir, { ...body, event: 'transition:IMPL_READY' });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PersistenceError);
      expect((caught as PersistenceError).code).toBe('SCHEMA_VALIDATION_FAILED');
      const { events } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe('transition:PLAN_READY');
    });

    it('keeps the chain verifiable across a re-delivered append', async () => {
      const body = makeValidAuditEvent();
      await appendAuditEvent(tmpDir, body);
      await appendAuditEvent(
        tmpDir,
        makeValidAuditEvent({ id: '00000000-0000-4000-8000-0000000000aa' }),
      );
      await appendAuditEvent(tmpDir, body);

      const { events } = await readAuditTrail(tmpDir);
      expect(events).toHaveLength(2);
      expect(verifyChain(events).valid).toBe(true);
    });
  });
});
