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
import { AuditEvent } from '../state/evidence.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import { auditPath, ensureDir, PersistenceError, isEnoent } from './persistence.js';

/**
 * Append a single audit event to the JSONL audit trail.
 *
 * Design:
 * - Zod-validates before appending (fail-closed)
 * - Single-line JSON (no pretty-print -- JSONL format)
 * - Trailing newline ensures clean append semantics
 * - appendFile is atomic for small writes on all major filesystems
 *   (a single audit event serializes to < 4KB, well within atomic write limits)
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param event - AuditEvent to append.
 */
export async function appendAuditEvent(sessionDir: string, event: AuditEvent): Promise<void> {
  const result = AuditEvent.safeParse(event);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to append invalid audit event: ${result.error.message}`,
    );
  }

  await ensureDir(sessionDir);
  const line = JSON.stringify(result.data) + '\n';
  try {
    await fs.appendFile(auditPath(sessionDir), line, 'utf-8');
  } catch (err: unknown) {
    getAdapterLogger().error('persistence-audit', 'Failed to append audit event', {
      sessionDir,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
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
