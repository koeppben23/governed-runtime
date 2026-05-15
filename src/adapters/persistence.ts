/**
 * @module persistence
 * @description Atomic file I/O for FlowGuard session and workspace data.
 *
 * This is the ONLY module that touches the filesystem for FlowGuard state.
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
 * @version v2
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import { SessionState } from '../state/schema.js';
import { AuditEvent, ReviewReport } from '../state/evidence.js';
import {
  DiscoveryResultSchema,
  ProfileResolutionSchema,
  type DiscoveryResult,
  type ProfileResolution,
} from '../discovery/types.js';
import {
  FlowGuardConfigSchema,
  DEFAULT_CONFIG,
  type FlowGuardConfig,
} from '../config/flowguard-config.js';

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
async function ensureDir(dir: string): Promise<void> {
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

// -- Session Write Lock --------------------------------------------------------

const SESSION_LOCK_FILE = 'session-state.json.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_INTERVAL_MS = 100;

/** Resolve the session write lock file path. */
export function sessionLockPath(sessionDir: string): string {
  return path.join(sessionDir, SESSION_LOCK_FILE);
}

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EEXIST';
}

/**
 * Check whether a process with the given PID is alive.
 * Extracted for testability — overridden via module mocking when needed.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // process not found → dead
    return true; // EPERM or unknown → fail-closed: treat as alive
  }
}

function buildLockContent(token: string): string {
  return `pid=${process.pid}\ntoken=${token}\n`;
}

/**
 * Handle representing an acquired session write lock.
 * Release is token-protected: it will only delete the lockfile
 * if it still contains the same token that was assigned at acquisition.
 */
export interface SessionWriteLock {
  release: () => Promise<void>;
}

/**
 * Acquire an exclusive session write lock via lockfile.
 *
 * Uses O_EXCL create ({@code fs.writeFile flag 'wx'}) for atomic acquisition.
 * If the lock is held by a live process, polls every 100 ms up to the timeout.
 * If the lock is held by a dead process (stale lock), removes it and retries.
 *
 * Prefer {@link withSessionWriteLock} for production code.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param timeoutMs - Lock acquisition timeout (default 10 seconds, min 100ms for tests).
 * @returns A lock handle with a token-protected {@code release()} method.
 * @throws PersistenceError with code {@code LOCK_TIMEOUT} if the lock cannot be acquired.
 */
export async function acquireSessionWriteLock(
  sessionDir: string,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<SessionWriteLock> {
  await ensureDir(sessionDir);
  const lockPath = sessionLockPath(sessionDir);
  const token = crypto.randomUUID();
  const content = buildLockContent(token);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await fs.writeFile(lockPath, content, { flag: 'wx' });
      return { release: () => releaseLock(lockPath, token) };
    } catch (err) {
      if (!isEexist(err)) throw err;
    }

    // Lock exists — check if stale
    const stale = await isLockStale(lockPath);
    if (stale) {
      try {
        await fs.unlink(lockPath);
      } catch (err) {
        if (!isEnoent(err)) {
          // unlink failed with EACCES/etc. — fail-closed
          throw new PersistenceError(
            'LOCK_TIMEOUT',
            `Cannot remove stale lock file: ${err instanceof Error ? err.message : String(err)}. ` +
              `Lock file: ${lockPath}`,
          );
        }
      }
      continue;
    }

    if (Date.now() >= deadline) {
      let blockingPid: number | undefined;
      try {
        const raw = await fs.readFile(lockPath, 'utf-8');
        const m = raw.match(/^pid=(\d+)/m);
        if (m) blockingPid = Number(m[1]);
      } catch {
        // Best-effort — lock file may have been removed
      }
      throw new PersistenceError(
        'LOCK_TIMEOUT',
        `Could not acquire session write lock within ${timeoutMs}ms.` +
          (blockingPid !== undefined
            ? `\n  Blocking PID: ${blockingPid}\n  Lock file: ${lockPath}\n` +
              `  If process ${blockingPid} is not running, delete the lock file manually.`
            : `\n  Lock file: ${lockPath}`),
      );
    }

    await new Promise((r) => setTimeout(r, LOCK_POLL_INTERVAL_MS));
  }
}

async function isLockStale(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return true; // lockfile disappeared — effectively stale
    return false; // EACCES or other — fail-closed: treat as alive
  }
  const pidMatch = raw.match(/^pid=(\d+)/m);
  if (!pidMatch) return false; // malformed lock — do not auto-delete
  const pid = Number(pidMatch[1]);
  return !isProcessAlive(pid);
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const current = await fs.readFile(lockPath, 'utf-8');
    const lines = current.split('\n');
    if (!lines.includes(`token=${token}`)) return;
    await fs.unlink(lockPath);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
}

/**
 * Execute a function under the session write lock.
 *
 * Acquires the lock before {@code fn}, releases it after (even on error).
 * This is the recommended API for production code.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param fn - Function to execute under the lock.
 * @param timeoutMs - Lock acquisition timeout (default 10 seconds).
 * @returns The return value of {@code fn}.
 * @throws PersistenceError with code {@code LOCK_TIMEOUT} if the lock cannot be acquired.
 */
export async function withSessionWriteLock<T>(
  sessionDir: string,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const lock = await acquireSessionWriteLock(sessionDir, timeoutMs);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
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

// -- Audit Operations ---------------------------------------------------------

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
    getAdapterLogger().error('persistence', 'Failed to append audit event', {
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
    getAdapterLogger().error('persistence', 'Failed to read audit trail', {
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

// -- Config Operations --------------------------------------------------------

/**
 * Read the FlowGuard config. Resolves deterministically:
 *   1. {worktree}/.opencode/flowguard.json (repo override, if worktree provided)
 *   2. ~/.config/opencode/flowguard.json (global default)
 *   3. DEFAULT_CONFIG (built-in fallback)
 *
 * Config is stored as a flat file — no longer under workspace fingerprint folders.
 *
 * @param worktree - Optional git worktree root for repo-scoped config.
 * @returns Fully normalized FlowGuardConfig (never null).
 */
export async function readConfig(worktree?: string): Promise<FlowGuardConfig> {
  // Repo-scoped config: {worktree}/.opencode/flowguard.json
  if (worktree) {
    const repoPath = repoConfigPath(worktree);
    try {
      const raw = await fs.readFile(repoPath, 'utf-8');
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new PersistenceError(
          'PARSE_FAILED',
          `Repo config file is not valid JSON: ${repoPath}`,
        );
      }
      const result = FlowGuardConfigSchema.safeParse(json);
      if (!result.success) {
        throw new PersistenceError(
          'SCHEMA_VALIDATION_FAILED',
          `Repo config failed schema validation: ${result.error.message}`,
        );
      }
      return result.data;
    } catch (err) {
      if (err instanceof PersistenceError) throw err;
      if (isEnoent(err)) {
        // Repo config not found — fall through to global
        getAdapterLogger().warn('persistence', 'Repo config not found, falling through to global', {
          repoPath,
        });
      } else {
        throw new PersistenceError(
          'READ_FAILED',
          `Failed to read repo config: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Fallback: global config
  const globalPath = globalConfigPath();
  try {
    const raw = await fs.readFile(globalPath, 'utf-8');
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new PersistenceError(
        'PARSE_FAILED',
        `Global config file is not valid JSON: ${globalPath}`,
      );
    }
    const result = FlowGuardConfigSchema.safeParse(json);
    if (!result.success) {
      throw new PersistenceError(
        'SCHEMA_VALIDATION_FAILED',
        `Global config failed schema validation: ${result.error.message}`,
      );
    }
    return result.data;
  } catch (err: unknown) {
    if (err instanceof PersistenceError) throw err;
    if (isEnoent(err)) {
      getAdapterLogger().warn('persistence', 'Global config not found, using defaults', {
        globalConfigPath: globalPath,
      });
      return structuredClone(DEFAULT_CONFIG);
    }
    throw new PersistenceError(
      'READ_FAILED',
      `Failed to read global config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Write a FlowGuard config to a target directory.
 *
 * Schema-validated before write (fail-closed — never persist invalid config).
 * Internal only — callers must use writeRepoConfig or writeGlobalConfig.
 *
 * @param targetDir - The directory containing flowguard.json.
 * @param config - The FlowGuardConfig to persist.
 * @throws PersistenceError if validation or write fails.
 */
async function writeConfig(targetDir: string, config: FlowGuardConfig): Promise<void> {
  const parsed = FlowGuardConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Config failed schema validation: ${parsed.error.message}`,
    );
  }
  await ensureDir(targetDir);
  const json = JSON.stringify(parsed.data, null, 2) + '\n';
  await atomicWrite(path.join(targetDir, CONFIG_FILE), json);
}

/**
 * Write a repo-scoped config to {worktree}/.opencode/flowguard.json.
 */
export async function writeRepoConfig(worktree: string, config: FlowGuardConfig): Promise<void> {
  return writeConfig(path.join(worktree, '.opencode'), config);
}

/**
 * Write the global config to ~/.config/opencode/flowguard.json.
 */
export async function writeGlobalConfig(config: FlowGuardConfig): Promise<void> {
  return writeConfig(path.dirname(globalConfigPath()), config);
}

// -- Discovery Operations -----------------------------------------------------

/**
 * Write a DiscoveryResult to {workspaceDir}/discovery/discovery.json.
 *
 * Schema-validated before write (fail-closed).
 * Atomic write for consistency.
 *
 * @param workspaceDir - Absolute path to the workspace directory.
 * @param result - The DiscoveryResult to persist.
 */
export async function writeDiscovery(workspaceDir: string, result: DiscoveryResult): Promise<void> {
  const parsed = DiscoveryResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `DiscoveryResult failed schema validation: ${parsed.error.message}`,
    );
  }
  const dir = path.join(workspaceDir, 'discovery');
  await ensureDir(dir);
  const json = JSON.stringify(parsed.data, null, 2) + '\n';
  await atomicWrite(path.join(dir, 'discovery.json'), json);
}

/**
 * Read a DiscoveryResult from {workspaceDir}/discovery/discovery.json.
 *
 * Returns null if the file does not exist.
 * Schema-validated on read (fail-closed on corruption).
 *
 * @param workspaceDir - Absolute path to the workspace directory.
 */
export async function readDiscovery(workspaceDir: string): Promise<DiscoveryResult | null> {
  const filePath = path.join(workspaceDir, 'discovery', 'discovery.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    getAdapterLogger().error('persistence', 'Failed to read discovery file', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new PersistenceError(
      'READ_FAILED',
      `Failed to read discovery file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PersistenceError('PARSE_FAILED', `Discovery file is not valid JSON`);
  }

  const parsed = DiscoveryResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Discovery file failed schema validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Write a ProfileResolution to {workspaceDir}/discovery/profile-resolution.json.
 *
 * Schema-validated before write. Atomic write.
 *
 * @param workspaceDir - Absolute path to the workspace directory.
 * @param resolution - The ProfileResolution to persist.
 */
export async function writeProfileResolution(
  workspaceDir: string,
  resolution: ProfileResolution,
): Promise<void> {
  const parsed = ProfileResolutionSchema.safeParse(resolution);
  if (!parsed.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `ProfileResolution failed schema validation: ${parsed.error.message}`,
    );
  }
  const dir = path.join(workspaceDir, 'discovery');
  await ensureDir(dir);
  const json = JSON.stringify(parsed.data, null, 2) + '\n';
  await atomicWrite(path.join(dir, 'profile-resolution.json'), json);
}

/**
 * Write a discovery snapshot to {sessionDir}/discovery-snapshot.json.
 *
 * Immutable per-session copy. Schema-validated before write.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param result - The DiscoveryResult to snapshot.
 */
export async function writeDiscoverySnapshot(
  sessionDir: string,
  result: DiscoveryResult,
): Promise<void> {
  const parsed = DiscoveryResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Discovery snapshot failed schema validation: ${parsed.error.message}`,
    );
  }
  await ensureDir(sessionDir);
  const json = JSON.stringify(parsed.data, null, 2) + '\n';
  await atomicWrite(path.join(sessionDir, 'discovery-snapshot.json'), json);
}

/**
 * Write a profile-resolution snapshot to {sessionDir}/profile-resolution-snapshot.json.
 *
 * Immutable per-session copy. Schema-validated before write.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param resolution - The ProfileResolution to snapshot.
 */
export async function writeProfileResolutionSnapshot(
  sessionDir: string,
  resolution: ProfileResolution,
): Promise<void> {
  const parsed = ProfileResolutionSchema.safeParse(resolution);
  if (!parsed.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Profile resolution snapshot failed schema validation: ${parsed.error.message}`,
    );
  }
  await ensureDir(sessionDir);
  const json = JSON.stringify(parsed.data, null, 2) + '\n';
  await atomicWrite(path.join(sessionDir, 'profile-resolution-snapshot.json'), json);
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
