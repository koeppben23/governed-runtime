/**
 * @module persistence-audit
 * @description Append-only JSONL audit trail operations (audit-chain.v3 only).
 *
 * Audit events are appended as single-line JSON with trailing newline.
 * Records that are not valid audit-chain.v3 records are rejected with
 * LEGACY_ASSURANCE_FORMAT_UNSUPPORTED — legacy artifacts are never
 * reinterpreted, migrated, or silently skipped.
 *
 * @version v3
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { AuditEvent, AuditEventBodySchema } from '../state/evidence.js';
import type { AuditEventBody } from '../state/evidence.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import {
  auditPath,
  ensureDir,
  PersistenceError,
  isEnoent,
  renameWithRetry,
} from './persistence.js';
import { getLastChainHash } from '../audit/integrity.js';
import { computeCanonicalEventDigest } from '../audit/canonical-digest.js';
import {
  computeChainHash,
  CURRENT_AUDIT_FORMAT_VERSION,
  type ChainedAuditEvent,
} from '../audit/types.js';

class AuditFormatError extends Error {
  readonly code = 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AuditFormatError';
  }
}
import { acquireNamedWriteLock } from './persistence-lock.js';

const AUDIT_LOCK_FILE = 'audit.jsonl.lock';
const AUDIT_LOCK_TIMEOUT_MS = 10_000;

/**
 * Append a single audit event to the JSONL audit trail.
 *
 * Design:
 * - Zod-validates the semantic body before appending (fail-closed)
 * - Single-line JSON (no pretty-print -- JSONL format)
 * - Trailing newline ensures clean append semantics
 * - Takes the session write lock to serialize concurrent appenders
 * - Rewrites via temp file + fsync + atomic rename to avoid partial trailing JSON
 * - The append authority stamps every positional/authority field under the
 *   lock: auditFormatVersion, auditSequence, recordedAt, semanticEventDigest,
 *   prevHash, and chainHash. Producer-supplied values for those fields are
 *   never accepted or persisted.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param event - Audit event semantic body (no positional/hash fields).
 * @returns The exact v3 event persisted to audit.jsonl.
 */
export async function appendAuditEvent(
  sessionDir: string,
  event: AuditEventBody,
): Promise<AuditEvent> {
  const result = AuditEventBodySchema.safeParse(event);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to append invalid audit event body: ${result.error.message}`,
    );
  }

  try {
    return await appendAuditLineAtomically(sessionDir, result.data);
  } catch (err: unknown) {
    getAdapterLogger().error('persistence-audit', 'Failed to append audit event', {
      sessionDir,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Normalize any audit body or persisted record to the canonical
 * `audit-chain.v3` commit body: semantic content plus the current format
 * version, with every positional/authority field removed.
 *
 * This is the single normalization used both when stamping a new event and
 * when comparing a re-delivered event against an already-persisted one, so
 * the exactly-once comparison is performed on exactly the shape the writer
 * commits. Without it, a raw producer body (which carries no
 * `auditFormatVersion`) never digests equal to its own persisted record —
 * which carries the writer-stamped version — and an honest retry would fail
 * closed as a duplicate-id-with-different-content violation.
 *
 * This is not a legacy or migration path: producer-supplied positional values
 * are dropped rather than interpreted, and the version is always forced to
 * CURRENT_AUDIT_FORMAT_VERSION. Non-v3 records are rejected before this point.
 */
function normalizeCurrentAuditBody(event: AuditEventBody | AuditEvent): Record<string, unknown> {
  const {
    auditFormatVersion: _format,
    auditSequence: _sequence,
    recordedAt: _recordedAt,
    semanticEventDigest: _semanticDigest,
    prevHash: _prevHash,
    chainHash: _chainHash,
    ...semantic
  } = event as Record<string, unknown>;
  return { ...semantic, auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION };
}

async function appendAuditLineAtomically(
  sessionDir: string,
  event: AuditEventBody,
): Promise<AuditEvent> {
  return await withAuditWriteLock(sessionDir, async () => {
    await ensureDir(sessionDir);
    const filePath = auditPath(sessionDir);
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tempPath = path.join(dir, `.${base}.${crypto.randomUUID()}.tmp`);
    let existing = '';

    try {
      existing = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    const existingTrail = parseAuditTrail(existing);

    if (existingTrail.skipped > 0) {
      throw new AuditFormatError(
        `Refusing to append: existing audit trail contains ${existingTrail.skipped} record(s) ` +
          'that are not valid audit-chain.v3 records. Legacy audit artifacts are unsupported.',
      );
    }

    // Exactly-once under the audit write lock: an event id is a commit
    // identity. A crash between append and acknowledgement may re-deliver the
    // SAME event — return the persisted record instead of appending a
    // duplicate. The same id with different content is a chain violation and
    // fails closed.
    const sameId = existingTrail.events.find((candidate) => candidate.id === event.id);
    if (sameId) {
      if (
        computeCanonicalEventDigest(normalizeCurrentAuditBody(sameId)) ===
        computeCanonicalEventDigest(normalizeCurrentAuditBody(event))
      ) {
        return sameId;
      }
      throw new PersistenceError(
        'SCHEMA_VALIDATION_FAILED',
        `Refusing to append audit event with duplicate id ${event.id} and different content`,
      );
    }

    // Stamp the positional/authority fields. Producers cannot influence
    // chain position, sequence authority, or record time — any
    // producer-supplied positional/hash value is dropped before stamping so
    // it can never leak into a computed digest.
    const bodyWithPosition: Omit<ChainedAuditEvent, 'chainHash'> = {
      ...normalizeCurrentAuditBody(event),
      auditSequence: existingTrail.events.length + 1,
      recordedAt: new Date().toISOString(),
      prevHash: getLastChainHash(existingTrail.events),
    } as unknown as Omit<ChainedAuditEvent, 'chainHash'>;
    const semanticEventDigest = computeCanonicalEventDigest(bodyWithPosition);
    const finalized: Omit<ChainedAuditEvent, 'chainHash'> = {
      ...bodyWithPosition,
      semanticEventDigest,
    };
    const chained = {
      ...finalized,
      chainHash: computeChainHash(finalized.prevHash, finalized),
    };
    const chainedResult = AuditEvent.safeParse(chained);
    if (!chainedResult.success) {
      throw new PersistenceError(
        'SCHEMA_VALIDATION_FAILED',
        `Refusing to append invalid chained audit event: ${chainedResult.error.message}`,
      );
    }
    const line = JSON.stringify(chainedResult.data) + '\n';

    try {
      const handle = await fs.open(tempPath, 'wx', 0o600);
      try {
        await handle.writeFile(existing + line, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(tempPath, filePath);
      return chainedResult.data;
    } catch (err) {
      try {
        await fs.unlink(tempPath);
      } catch {
        /* temp may not exist or may already have been renamed */
      }
      throw err;
    }
  });
}

function parseAuditTrail(raw: string): { events: AuditEvent[]; skipped: number } {
  const events: AuditEvent[] = [];
  const skipped = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new AuditFormatError(
        'Audit trail contains a record that is not valid JSONL. Legacy or malformed ' +
          'assurance artifacts are unsupported.',
      );
    }
    const result = AuditEvent.safeParse(json);
    if (!result.success) {
      // Fail closed with an explicit epoch error: pre-v3 records must never
      // be reinterpreted, migrated, or silently skipped.
      throw new AuditFormatError(
        'Audit trail contains a record that is not a valid audit-chain.v3 record. ' +
          'Legacy assurance artifacts are unsupported.',
      );
    }
    events.push(result.data);
  }

  return { events, skipped };
}

async function withAuditWriteLock<T>(sessionDir: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireAuditWriteLock(sessionDir);
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function acquireAuditWriteLock(sessionDir: string): Promise<() => Promise<void>> {
  const lock = await acquireNamedWriteLock(
    sessionDir,
    AUDIT_LOCK_FILE,
    'audit write',
    AUDIT_LOCK_TIMEOUT_MS,
  );
  return lock.release;
}

/**
 * Read all audit events from the JSONL trail.
 *
 * Returns empty array if no audit file exists.
 * Fails closed with LEGACY_ASSURANCE_FORMAT_UNSUPPORTED on any record that
 * is not a valid audit-chain.v3 record — legacy or malformed records are
 * never reinterpreted or skipped.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @returns Object with events array and skipped count (always 0 — rejects instead).
 */
export async function readAuditTrail(
  sessionDir: string,
): Promise<{ events: AuditEvent[]; skipped: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(auditPath(sessionDir), 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return { events: [], skipped: 0 };
    getAdapterLogger().error('persistence-audit', 'Failed to read audit trail', {
      filePath: auditPath(sessionDir),
      error: err instanceof Error ? err.message : String(err),
    });
    throw new PersistenceError(
      'READ_FAILED',
      `Failed to read audit trail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parseAuditTrail(raw);
}
