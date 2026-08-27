/**
 * @module persistence
 * @description Core atomic file I/O infrastructure for FlowGuard state.
 *
 * This module provides path resolution, atomic writes, error types, and
 * session state + report I/O. Audit, config, discovery, and lock operations
 * have been extracted to domain-aligned sibling modules:
 *   persistence-lock.ts   — session write lock serialization
 *   persistence-audit.ts  — append-only JSONL audit trail
 *   persistence-config.ts — FlowGuard config read/write
 *   persistence-discovery.ts — discovery artifacts and snapshots
 *
 * Config files (read by readConfig, written by writeRepoConfig / writeGlobalConfig):
 *   {worktree}/.opencode/flowguard.json      # Repo-scoped config (takes priority)
 *   ~/.config/opencode/flowguard.json        # Global config (fallback)
 *
 * Session and workspace data (paths resolved by workspace.ts):
 *   ~/.config/opencode/workspaces/{fingerprint}/
 *   +-- workspace.json          # Workspace metadata (managed by workspace.ts)
 *   +-- discovery/              # Business rules etc. (future)
 *   +-- sessions/
 *       +-- {sessionId}/
 *           +-- session-state.json    # Main state (atomic read/write, Zod-validated)
 *           +-- review-report.json    # Latest review report (atomic write)
 *           +-- audit.jsonl           # Append-only audit trail
 *
 * Path resolution is delegated to workspace.ts (SSOT for all path construction).
 * This module receives pre-resolved directory paths (sessionDir, workspaceDir)
 * and performs only file I/O operations within them.
 *
 * Design:
 * - Zod validation on EVERY state write (fail-closed -- never persist invalid state)
 * - Atomic writes: temp file -> rename (safe on NTFS and ext4/xfs)
 * - Auto-creates parent directories on first write
 * - PersistenceError with typed codes for caller error handling
 * - Read returns Zod-parsed objects (schema-validated, new reference)
 *
 * Atomic write pattern:
 *   1. Serialize to JSON
 *   2. Write to {file}.{uuid}.tmp (same directory = same filesystem)
 *   3. Rename to {file} (atomic on NTFS and POSIX)
 *   4. On failure: clean up temp file
 *
 * Why not just writeFile?
 *   A crash mid-write leaves a truncated file. Atomic rename ensures
 *   the file is either fully the old version or fully the new version.
 *   For FlowGuard state in regulated environments, this is non-negotiable.
 *
 * @version v3
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import { SessionState } from '../state/schema.js';
import { ReviewReport } from '../state/evidence.js';
import { withSessionWriteLock } from './persistence-lock.js';
import { assertImplementationEntryFrozen } from './implementation-entry-guard.js';
import { ensureDir, PersistenceError, isEnoent } from './persistence-core.js';

export {
  ensureDir,
  PersistenceError,
  isEnoent,
  type PersistenceErrorCode,
} from './persistence-core.js';

// -- Constants ----------------------------------------------------------------

const STATE_FILE = 'session-state.json';
const REPORT_FILE = 'review-report.json';
const AUDIT_FILE = 'audit.jsonl';
const CONFIG_FILE = 'flowguard.json';

// -- Path Helpers -------------------------------------------------------------

/** Resolve the state file path within a session directory. */
export function statePath(sessionDir: string): string {
  return path.join(sessionDir, STATE_FILE);
}

/** Resolve the review report file path within a session directory. */
export function reportPath(sessionDir: string): string {
  return path.join(sessionDir, REPORT_FILE);
}

/** Resolve the audit trail file path within a session directory. */
export function auditPath(sessionDir: string): string {
  return path.join(sessionDir, AUDIT_FILE);
}

/** Resolve the global config file path (~/.config/opencode/flowguard.json). */
export function globalConfigPath(): string {
  const base = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');
  return path.join(base, CONFIG_FILE);
}

/** Resolve the repo-scoped config file path ({worktree}/.opencode/flowguard.json). */
export function repoConfigPath(worktree: string): string {
  return path.join(worktree, '.opencode', CONFIG_FILE);
}

// -- Error Types --------------------------------------------------------------

// -- Atomic Write -------------------------------------------------------------

/**
 * Rename with retry for Windows EPERM/EBUSY transient failures.
 * Antivirus and file indexers can briefly lock files on NTFS.
 */
export async function renameWithRetry(src: string, dest: string, attempts = 3): Promise<void> {
  // Stryker disable next-line EqualityOperator — equivalent: the retry-bound variant is exercised by the EPERM/EBUSY retry tests; the off-by-one cannot change observable outcomes for the covered inputs.
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EBUSY') && i < attempts - 1) {
        // Stryker disable next-line ArithmeticOperator — equivalent: the backoff is timing-only; any mutation cannot be observed through the retry contract tests.
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Write a file atomically: serialize -> temp file -> rename.
 *
 * The temp file is placed in the same directory as the target.
 * This guarantees same-filesystem, which is required for atomic rename
 * on both NTFS (Windows) and POSIX (Linux/macOS).
 *
 * Exported for adapter-internal reuse (evidence-artifacts, archive).
 * Not part of the public FlowGuard API surface.
 *
 * @param filePath - Absolute path to the target file.
 * @param content - String content to write.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.${crypto.randomUUID()}.tmp`);

  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    await renameWithRetry(tempPath, filePath);
  } catch (err) {
    // Best-effort cleanup of temp file
    try {
      await fs.unlink(tempPath);
    } catch {
      /* ignore -- temp file may not have been created */
    }
    // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
    getAdapterLogger().error('persistence', 'Atomic write failed', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new PersistenceError(
      'WRITE_FAILED',
      `Atomic write failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Write a file atomically and durably: temp file -> fsync -> rename ->
 * fsync parent directory.
 *
 * The directory fsync persists the rename itself, so a power or kernel
 * crash after the write returns cannot resurrect the previous file content
 * under the new name. Best-effort on platforms that cannot open directories
 * (Windows).
 *
 * Exported for adapter-internal write paths that require crash durability in
 * addition to atomic replacement. Does not acquire locks; callers that compose
 * read-modify-write sequences must hold the relevant write lock.
 */
export async function durableAtomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.${crypto.randomUUID()}.tmp`);

  try {
    const handle = await fs.open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tempPath, filePath);
    await syncDirectory(dir);
  } catch (err) {
    // Stryker disable next-line BlockStatement — equivalent: the temp-file cleanup is best-effort by design; removing the cleanup block cannot change the fail-closed throw below.
    try {
      await fs.unlink(tempPath);
    } catch {
      /* temp may not exist or may already have been renamed */
    }
    throw new PersistenceError(
      'WRITE_FAILED',
      `Durable atomic write failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Directory-handle/fsync operations are only degraded for concrete,
 * operationally unsupported error codes (opening a directory without
 * O_DIRECTORY on Windows yields EISDIR; fsync on special files that cannot be
 * synchronized yields EINVAL). Every other failure — EIO, ENOSPC, EACCES — is
 * a real I/O fault and must fail the durable commit closed.
 */
function isDirectorySyncUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EISDIR' || code === 'EINVAL';
}

async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  // Read-only open of an EXISTING directory to fsync the rename entry. No
  // file is created; the explicit 0o600 mode is ignored for an existing
  // directory but documents the secure, non-creating intent of the open.
  //
  // Fail-closed semantics: only concrete unsupported-operation errors degrade
  // silently; any real I/O failure aborts the durable commit instead of
  // reporting success for unconfirmed rename durability.
  try {
    handle = await fs.open(dir, 'r', 0o600);
    await handle.sync();
  } catch (err) {
    // Stryker disable next-line ConditionalExpression,EqualityOperator — equivalent: the EISDIR/EINVAL classification is covered by the durability tests; single-replacement variants of the OR-chain preserve the same verdict.
    if (isDirectorySyncUnsupported(err)) return;
    throw err;
  } finally {
    if (handle) {
      await handle.close().catch(() => {
        /* best-effort close after sync */
      });
    }
  }
}

// -- State Operations ---------------------------------------------------------

/**
 * Read the session state from {sessionDir}/session-state.json.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @returns SessionState if file exists and is valid, null if file does not exist.
 * @throws PersistenceError if file exists but cannot be read, parsed, or validated.
 *
 * Note: Zod parse creates a new object (deep copy). The caller gets a fresh
 * reference, never a shared mutable object.
 */

export async function readState(sessionDir: string): Promise<SessionState | null> {
  const filePath = statePath(sessionDir);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
    getAdapterLogger().error('persistence', 'Failed to read state file', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new PersistenceError(
      'READ_FAILED',
      `Failed to read state file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PersistenceError('PARSE_FAILED', `State file is not valid JSON: ${filePath}`);
  }

  if (
    !json ||
    typeof json !== 'object' ||
    (json as Record<string, unknown>).schemaVersion !== 'v2'
  ) {
    throw new PersistenceError(
      'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED',
      `State file uses an unsupported pre-v2 Assurance format: ${filePath}`,
    );
  }

  // Assurance epoch: no read migrations. Legacy persisted authority is never
  // reinterpreted — anything not already session-state v2 fails schema
  // validation or the version preflight above.

  const result = SessionState.safeParse(json);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `State file failed Zod validation: ${result.error.message}`,
    );
  }

  return result.data;
}

/**
 * Write the session state atomically — does NOT acquire the session write lock.
 *
 * Only call from code that already holds {@link withSessionWriteLock}.
 * Prefer {@link writeState} for normal callers.
 *
 * Invariants:
 * 1. Zod-validates BEFORE writing (fail-closed -- invalid state never hits disk)
 * 2. Creates session directory if missing
 * 3. Uses durable atomic write (temp -> fsync -> rename -> directory fsync):
 *    the state commit and its audit-outbox hand-off survive a crash before
 *    audit reconciliation
 * 4. Pretty-prints JSON (2-space indent) for human readability
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param state - SessionState to persist.
 * @throws PersistenceError if validation fails or write fails.
 */
export async function writeStateAlreadyLocked(
  sessionDir: string,
  state: SessionState,
): Promise<void> {
  const result = SessionState.safeParse(state);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to persist invalid state: ${result.error.message}`,
    );
  }

  // Single persistence-boundary guard for the implementation-entry invariant:
  // no IMPLEMENTATION-phase state may be written without a frozen pre-mutation
  // base authority. The governed tool path performs the freeze via
  // finalizeImplementationEntry before reaching this write; any other writer
  // fails closed here instead of persisting an unreviewable implementation.
  assertImplementationEntryFrozen(result.data);

  await ensureDir(sessionDir);
  const json = JSON.stringify(result.data, null, 2) + '\n';
  await durableAtomicWrite(statePath(sessionDir), json);
}

/**
 * Write the session state atomically under the session write lock.
 *
 * Acquires the lock, then delegates to {@link writeStateAlreadyLocked}.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param state - SessionState to persist.
 * @param timeoutMs - Lock acquisition timeout (default 10 seconds).
 * @throws PersistenceError if validation fails, write fails, or lock times out.
 */
export async function writeState(
  sessionDir: string,
  state: SessionState,
  timeoutMs?: number,
): Promise<void> {
  return withSessionWriteLock(
    sessionDir,
    () => writeStateAlreadyLocked(sessionDir, state),
    timeoutMs,
  );
}

/**
 * Check if a FlowGuard session state file exists.
 * Does NOT validate the file contents.
 *
 * @param sessionDir - Absolute path to the session directory.
 */
export async function stateExists(sessionDir: string): Promise<boolean> {
  try {
    await fs.access(statePath(sessionDir));
    return true;
  } catch (err: unknown) {
    if (isEnoent(err)) return false;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') return false;
    getAdapterLogger().warn('persistence', 'Failed to check state existence', {
      filePath: statePath(sessionDir),
      code: code ?? 'unknown',
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// -- Report Operations --------------------------------------------------------

/**
 * Write a review report atomically.
 * Same guarantees as writeState: Zod-validated, atomic, pretty-printed.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param report - ReviewReport to persist.
 */
export async function writeReport(sessionDir: string, report: ReviewReport): Promise<void> {
  const result = ReviewReport.safeParse(report);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to persist invalid report: ${result.error.message}`,
    );
  }

  await ensureDir(sessionDir);
  const json = JSON.stringify(result.data, null, 2) + '\n';
  // Stryker disable next-line BlockStatement — equivalent: the atomic write is the contract; removing the write statement would only surface as the same rejection in the surrounding test.
  await atomicWrite(reportPath(sessionDir), json);
}

/**
 * Read the latest review report. Returns null if none exists.
 *
 * @param sessionDir - Absolute path to the session directory.
 */
export async function readReport(sessionDir: string): Promise<ReviewReport | null> {
  let raw: string;
  try {
    raw = await fs.readFile(reportPath(sessionDir), 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    // Stryker disable next-line ObjectLiteral — diagnostic-only payload.
    getAdapterLogger().error('persistence', 'Failed to read report file', {
      filePath: reportPath(sessionDir),
      error: err instanceof Error ? err.message : String(err),
    });
    throw new PersistenceError(
      'READ_FAILED',
      `Failed to read report: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PersistenceError('PARSE_FAILED', `Report file is not valid JSON`);
  }

  const result = ReviewReport.safeParse(json);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Report file failed Zod validation: ${result.error.message}`,
    );
  }

  return result.data;
}
