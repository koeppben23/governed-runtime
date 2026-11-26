/**
 * @module persistence-hook-ingest
 * @description Bounded transport ingestion-failure ledger for hop payloads that
 * can never become a tool-call audit event (oversized, malformed, unreadable).
 *
 * This ledger is deliberately NOT an audit trail:
 * - it carries no session id, no audit-chain linkage, and no enforcement claim;
 * - it stores metadata only (reason code, observed byte count, digest of the
 *   observed prefix) and never raw payload bytes;
 * - it is bounded (single-generation rotation) and lock-protected with a short
 *   bounded wait so a failing ledger can never make an informational hook hang.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import { hashBuffer } from '../shared/hashing.js';
import { hookIngestFailureLogPath } from './persistence.js';
import { isEnoent } from './persistence-core.js';
import { acquireNamedWriteLock } from './persistence-lock.js';

export const HOOK_INGEST_FAILURE_SCHEMA_VERSION = 'hook-ingest-failure.v1';

/**
 * Rotation threshold in bytes. This is a pre-append threshold, not a strict
 * maximum file size: a single record appended at the threshold may leave the
 * active file slightly above it until the next append rotates it.
 */
export const HOOK_INGEST_FAILURE_MAX_BYTES = 256 * 1024;

const LEDGER_LOCK_FILE = 'flowguard-hook-ingest-failures.lock';
/**
 * Bounded lock wait with 100ms polling: tolerates a handful of concurrent hook
 * processes while keeping a broken/contended ledger from stalling an
 * informational hook (the host PostToolUse window is 30s). The wait bounds lock
 * acquisition only — it does not bound every subsequent filesystem operation.
 */
const LEDGER_LOCK_TIMEOUT_MS = 1_500;

export type HookIngestTransport = 'command_hook' | 'http_hook';

export interface HookIngestFailureInput {
  readonly transport: HookIngestTransport;
  readonly event: 'PostToolUse';
  /** Transport ingestion code (e.g. STDIN_TOO_LARGE, HOOK_PAYLOAD_INVALID). */
  readonly reasonCode: string;
  /** Bytes actually observed by the reader, or null when unobservable. */
  readonly observedBytes: number | null;
  /**
   * The observed prefix as raw bytes, or null when no bytes could be retained.
   * Only these raw bytes are hashed (binary-exact, never a UTF-8 replacement
   * form); nothing beyond the observed, cap-bounded prefix is claimed.
   */
  readonly observedPrefix: Buffer | null;
}

export interface HookIngestFailureRecord {
  readonly schemaVersion: typeof HOOK_INGEST_FAILURE_SCHEMA_VERSION;
  readonly occurredAt: string;
  readonly transport: HookIngestTransport;
  readonly event: 'PostToolUse';
  readonly reasonCode: string;
  readonly observedBytes: number | null;
  readonly observedPrefixDigest: string | null;
  readonly digestScope: 'observed_prefix' | 'unavailable';
}

export interface HookIngestAppendResult {
  readonly recorded: boolean;
  readonly reason?: string;
}

/**
 * Persist one bounded ingestion-failure record. Never throws and never blocks
 * longer than the bounded lock wait; a failed ledger write is logged and
 * reported so the caller can surface the operational limitation.
 */
export async function appendHookIngestFailure(
  input: HookIngestFailureInput,
): Promise<HookIngestAppendResult> {
  const logPath = hookIngestFailureLogPath();
  const directory = path.dirname(logPath);
  let lock: Awaited<ReturnType<typeof acquireNamedWriteLock>>;
  try {
    await fs.mkdir(directory, { recursive: true });
    lock = await acquireNamedWriteLock(
      directory,
      LEDGER_LOCK_FILE,
      'hook-ingest-failure-ledger',
      LEDGER_LOCK_TIMEOUT_MS,
    );
  } catch (err) {
    getAdapterLogger().warn('hook-ingest', 'ledger-lock-unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { recorded: false, reason: 'LOCK_UNAVAILABLE' };
  }

  try {
    await rotateIfOversized(logPath);
    const record: HookIngestFailureRecord = {
      schemaVersion: HOOK_INGEST_FAILURE_SCHEMA_VERSION,
      occurredAt: new Date().toISOString(),
      transport: input.transport,
      event: input.event,
      reasonCode: input.reasonCode,
      observedBytes: input.observedBytes,
      observedPrefixDigest: input.observedPrefix === null ? null : hashBuffer(input.observedPrefix),
      digestScope: input.observedPrefix === null ? 'unavailable' : 'observed_prefix',
    };
    await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return { recorded: true };
  } catch (err) {
    getAdapterLogger().warn('hook-ingest', 'ledger-append-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { recorded: false, reason: 'WRITE_FAILED' };
  } finally {
    await lock.release().catch(() => {});
  }
}

/** Keep the ledger bounded: at most one rotated generation is retained. */
async function rotateIfOversized(logPath: string): Promise<void> {
  let size: number;
  try {
    size = (await fs.stat(logPath)).size;
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  if (size < HOOK_INGEST_FAILURE_MAX_BYTES) return;
  const rotated = `${logPath}.1`;
  // Windows rename does not overwrite an existing destination.
  await fs.rm(rotated, { force: true });
  await fs.rename(logPath, rotated);
}
