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

/**
 * Typed persistence error codes.
 * Compile-time validated — no arbitrary strings allowed.
 */
export type PersistenceErrorCode =
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'PARSE_FAILED'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'LOCK_TIMEOUT';

/**
 * Typed persistence error.
 * Codes:
 * - READ_FAILED: filesystem read error (permissions, disk, etc.)
 * - PARSE_FAILED: file is not valid JSON
 * - SCHEMA_VALIDATION_FAILED: JSON parsed but Zod validation rejected it
 * - WRITE_FAILED: filesystem write error
 * - LOCK_TIMEOUT: session-state write lock could not be acquired within timeout
 */
export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
  }
}

// -- Directory ----------------------------------------------------------------

/**
 * Ensure a directory exists. Idempotent.
 * Uses recursive mkdir -- safe to call even if parent dirs are missing.
 */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

// -- Atomic Write -------------------------------------------------------------

/**
 * Rename with retry for Windows EPERM/EBUSY transient failures.
 * Antivirus and file indexers can briefly lock files on NTFS.
 */
async function renameWithRetry(src: string, dest: string, attempts = 3): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EBUSY') && i < attempts - 1) {
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
    await fs.writeFile(tempPath, content, 'utf-8');
    await renameWithRetry(tempPath, filePath);
  } catch (err) {
    // Best-effort cleanup of temp file
    try {
      await fs.unlink(tempPath);
    } catch {
      /* ignore -- temp file may not have been created */
    }
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
 * 3. Uses atomic write (temp -> rename)
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

  await ensureDir(sessionDir);
  const json = JSON.stringify(result.data, null, 2) + '\n';
  await atomicWrite(statePath(sessionDir), json);
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

// -- Internals ----------------------------------------------------------------

/** Type-safe ENOENT check. Shared by persistence and git adapters. */
export function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
