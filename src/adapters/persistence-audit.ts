/**
 * @module persistence-audit
 * @description Append-only JSONL audit trail operations.
 *
 * Audit events are appended as single-line JSON with trailing newline.
 * Reads tolerate corrupted lines and report a skipped count.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { AuditEvent } from '../state/evidence.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import { auditPath, ensureDir, PersistenceError, isEnoent } from './persistence.js';
import { getLastChainHash } from '../audit/integrity.js';
import { computeChainHash, type ChainedAuditEvent } from '../audit/types.js';

const AUDIT_LOCK_FILE = 'audit.jsonl.lock';
const AUDIT_LOCK_TIMEOUT_MS = 10_000;
const AUDIT_LOCK_POLL_MS = 100;

/**
 * Append a single audit event to the JSONL audit trail.
 *
 * Design:
 * - Zod-validates before appending (fail-closed)
 * - Single-line JSON (no pretty-print -- JSONL format)
 * - Trailing newline ensures clean append semantics
 * - Takes the session write lock to serialize concurrent appenders
 * - Rewrites via temp file + fsync + atomic rename to avoid partial trailing JSON
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param event - AuditEvent body to append. prevHash/chainHash are recomputed under lock.
 * @returns The exact chained event persisted to audit.jsonl.
 */
export async function appendAuditEvent(sessionDir: string, event: AuditEvent): Promise<AuditEvent> {
  const result = AuditEvent.safeParse(event);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to append invalid audit event: ${result.error.message}`,
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

async function appendAuditLineAtomically(
  sessionDir: string,
  event: AuditEvent,
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
      throw new PersistenceError(
        'READ_FAILED',
        `Refusing to append: existing audit trail contains ${existingTrail.skipped} unparseable line(s). ` +
          'The corrupt portion must be repaired before new events can be appended.',
      );
    }

    const eventBody = { ...event } as Record<string, unknown>;
    delete eventBody.prevHash;
    delete eventBody.chainHash;
    const prevHash = getLastChainHash(existingTrail.events);
    const bodyWithPrevHash = { ...eventBody, prevHash } as Omit<ChainedAuditEvent, 'chainHash'>;
    const chained = {
      ...bodyWithPrevHash,
      chainHash: computeChainHash(prevHash, bodyWithPrevHash),
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
      await fs.rename(tempPath, filePath);
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
  let skipped = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const json = JSON.parse(trimmed);
      const result = AuditEvent.safeParse(json);
      if (result.success) {
        events.push(result.data);
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
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
  await ensureDir(sessionDir);
  const lockPath = path.join(sessionDir, AUDIT_LOCK_FILE);
  const token = crypto.randomUUID();
  const deadline = Date.now() + AUDIT_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await fs.writeFile(lockPath, `pid=${process.pid}\ntoken=${token}\n`, {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600,
      });
      return async () => {
        try {
          const current = await fs.readFile(lockPath, 'utf-8');
          if (current.split('\n').includes(`token=${token}`)) await fs.unlink(lockPath);
        } catch (err) {
          if (!isEnoent(err)) throw err;
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) {
        throw new PersistenceError(
          'LOCK_TIMEOUT',
          `Could not acquire audit write lock within ${AUDIT_LOCK_TIMEOUT_MS}ms.\n  Lock file: ${lockPath}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, AUDIT_LOCK_POLL_MS));
    }
  }
}

/**
 * Read all audit events from the JSONL trail.
 *
 * Returns empty array if no audit file exists.
 * Skips malformed lines with best-effort tolerance:
 * - The audit trail is append-only. A single corrupt line should not
 *   prevent reading all other events.
 * - Corrupted lines are counted in the returned metadata for diagnostics.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @returns Object with events array and optional skipped count.
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
