/**
 * @module persistence
 * @description Atomic file I/O for the .flowguard/ directory.
 *
 * This is the ONLY module that touches the filesystem for FlowGuard state.
 * All FlowGuard files live under {worktree}/.flowguard/:
 *
 *   .flowguard/
 *   +-- session-state.json    # Main state (atomic read/write, Zod-validated)
 *   +-- review-report.json    # Latest review report (atomic write)
 *   +-- audit.jsonl           # Append-only audit trail
 *   +-- config.json           # Per-worktree configuration (atomic read/write, Zod-validated)
 *
 * Design:
 * - Zod validation on EVERY state write (fail-closed -- never persist invalid state)
 * - Atomic writes: temp file -> rename (safe on NTFS and ext4/xfs)
 * - Auto-creates .flowguard/ directory on first write
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
 * @version v1
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SessionState } from "../state/schema";
import { AuditEvent, ReviewReport } from "../state/evidence";
import {
  FlowGuardConfigSchema,
  DEFAULT_CONFIG,
  type FlowGuardConfig,
} from "../config/flowguard-config";

// -- Constants ----------------------------------------------------------------

const FG_DIR = ".flowguard";
const STATE_FILE = "session-state.json";
const REPORT_FILE = "review-report.json";
const AUDIT_FILE = "audit.jsonl";
const CONFIG_FILE = "config.json";

// -- Path Helpers -------------------------------------------------------------

/** Resolve the .flowguard directory path for a worktree. */
export function fgDir(worktree: string): string {
  return path.join(worktree, FG_DIR);
}

/** Resolve the state file path. */
export function statePath(worktree: string): string {
  return path.join(worktree, FG_DIR, STATE_FILE);
}

/** Resolve the review report file path. */
export function reportPath(worktree: string): string {
  return path.join(worktree, FG_DIR, REPORT_FILE);
}

/** Resolve the audit trail file path. */
export function auditPath(worktree: string): string {
  return path.join(worktree, FG_DIR, AUDIT_FILE);
}

/** Resolve the config file path. */
export function configPath(worktree: string): string {
  return path.join(worktree, FG_DIR, CONFIG_FILE);
}

// -- Error --------------------------------------------------------------------

/**
 * Typed persistence error.
 * Codes:
 * - READ_FAILED: filesystem read error (permissions, disk, etc.)
 * - PARSE_FAILED: file is not valid JSON
 * - SCHEMA_VALIDATION_FAILED: JSON parsed but Zod validation rejected it
 * - WRITE_FAILED: filesystem write error
 */
export class PersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
  }
}

// -- Directory ----------------------------------------------------------------

/**
 * Ensure the .flowguard/ directory exists. Idempotent.
 * Uses recursive mkdir -- safe to call even if parent dirs are missing.
 */
async function ensureDir(worktree: string): Promise<void> {
  await fs.mkdir(fgDir(worktree), { recursive: true });
}

// -- Atomic Write -------------------------------------------------------------

/**
 * Write a file atomically: serialize -> temp file -> rename.
 *
 * The temp file is placed in the same directory as the target.
 * This guarantees same-filesystem, which is required for atomic rename
 * on both NTFS (Windows) and POSIX (Linux/macOS).
 *
 * @param filePath - Absolute path to the target file.
 * @param content - String content to write.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.${crypto.randomUUID()}.tmp`);

  try {
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, filePath);
  } catch (err) {
    // Best-effort cleanup of temp file
    try {
      await fs.unlink(tempPath);
    } catch {
      /* ignore -- temp file may not have been created */
    }
    throw new PersistenceError(
      "WRITE_FAILED",
      `Atomic write failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// -- State Operations ---------------------------------------------------------

/**
 * Read the session state from .flowguard/session-state.json.
 *
 * @returns SessionState if file exists and is valid, null if file does not exist.
 * @throws PersistenceError if file exists but cannot be read, parsed, or validated.
 *
 * Note: Zod parse creates a new object (deep copy). The caller gets a fresh
 * reference, never a shared mutable object.
 */
export async function readState(worktree: string): Promise<SessionState | null> {
  const filePath = statePath(worktree);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw new PersistenceError(
      "READ_FAILED",
      `Failed to read state file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PersistenceError(
      "PARSE_FAILED",
      `State file is not valid JSON: ${filePath}`,
    );
  }

  const result = SessionState.safeParse(json);
  if (!result.success) {
    throw new PersistenceError(
      "SCHEMA_VALIDATION_FAILED",
      `State file failed Zod validation: ${result.error.message}`,
    );
  }

  return result.data;
}

/**
 * Write the session state atomically.
 *
 * Invariants:
 * 1. Zod-validates BEFORE writing (fail-closed -- invalid state never hits disk)
 * 2. Creates .flowguard/ directory if missing
 * 3. Uses atomic write (temp -> rename)
 * 4. Pretty-prints JSON (2-space indent) for human readability and git diffs
 *
 * @throws PersistenceError if validation fails or write fails.
 */
export async function writeState(
  worktree: string,
  state: SessionState,
): Promise<void> {
  // Validate BEFORE writing -- fail-closed
  const result = SessionState.safeParse(state);
  if (!result.success) {
    throw new PersistenceError(
      "SCHEMA_VALIDATION_FAILED",
      `Refusing to persist invalid state: ${result.error.message}`,
    );
  }

  await ensureDir(worktree);
  const json = JSON.stringify(result.data, null, 2) + "\n";
  await atomicWrite(statePath(worktree), json);
}

/**
 * Check if a FlowGuard session state file exists.
 * Does NOT validate the file contents.
 */
export async function stateExists(worktree: string): Promise<boolean> {
  try {
    await fs.access(statePath(worktree));
    return true;
  } catch {
    return false;
  }
}

// -- Report Operations --------------------------------------------------------

/**
 * Write a review report atomically.
 * Same guarantees as writeState: Zod-validated, atomic, pretty-printed.
 */
export async function writeReport(
  worktree: string,
  report: ReviewReport,
): Promise<void> {
  const result = ReviewReport.safeParse(report);
  if (!result.success) {
    throw new PersistenceError(
      "SCHEMA_VALIDATION_FAILED",
      `Refusing to persist invalid report: ${result.error.message}`,
    );
  }

  await ensureDir(worktree);
  const json = JSON.stringify(result.data, null, 2) + "\n";
  await atomicWrite(reportPath(worktree), json);
}

/**
 * Read the latest review report. Returns null if none exists.
 */
export async function readReport(
  worktree: string,
): Promise<ReviewReport | null> {
  let raw: string;
  try {
    raw = await fs.readFile(reportPath(worktree), "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw new PersistenceError(
      "READ_FAILED",
      `Failed to read report: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PersistenceError(
      "PARSE_FAILED",
      `Report file is not valid JSON`,
    );
  }

  const result = ReviewReport.safeParse(json);
  if (!result.success) {
    throw new PersistenceError(
      "SCHEMA_VALIDATION_FAILED",
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
 */
export async function appendAuditEvent(
  worktree: string,
  event: AuditEvent,
): Promise<void> {
  const result = AuditEvent.safeParse(event);
  if (!result.success) {
    throw new PersistenceError(
      "SCHEMA_VALIDATION_FAILED",
      `Refusing to append invalid audit event: ${result.error.message}`,
    );
  }

  await ensureDir(worktree);
  const line = JSON.stringify(result.data) + "\n";
  await fs.appendFile(auditPath(worktree), line, "utf-8");
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
 * @returns Object with events array and optional skipped count.
 */
export async function readAuditTrail(
  worktree: string,
): Promise<{ events: AuditEvent[]; skipped: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(auditPath(worktree), "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) return { events: [], skipped: 0 };
    throw new PersistenceError(
      "READ_FAILED",
      `Failed to read audit trail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const events: AuditEvent[] = [];
  let skipped = 0;

  for (const line of raw.split("\n")) {
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
 * Read the FlowGuard config from .flowguard/config.json.
 *
 * Always returns a fully normalized FlowGuardConfig:
 * - If the file does not exist → returns DEFAULT_CONFIG (all defaults applied).
 * - If the file exists and is valid → returns Zod-parsed config (defaults filled).
 * - If the file exists but is invalid JSON → throws PersistenceError(PARSE_FAILED).
 * - If the file exists but fails schema validation → throws PersistenceError(SCHEMA_VALIDATION_FAILED).
 * - If the file cannot be read → throws PersistenceError(READ_FAILED).
 *
 * Design: readConfig never returns null. Every caller sees a complete config
 * object with all fields populated — no defensive checks needed downstream.
 */
export async function readConfig(worktree: string): Promise<FlowGuardConfig> {
  const filePath = configPath(worktree);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) return DEFAULT_CONFIG;
    throw new PersistenceError(
      "READ_FAILED",
      `Failed to read config file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PersistenceError(
      "PARSE_FAILED",
      `Config file is not valid JSON: ${filePath}`,
    );
  }

  const result = FlowGuardConfigSchema.safeParse(json);
  if (!result.success) {
    throw new PersistenceError(
      "SCHEMA_VALIDATION_FAILED",
      `Config file failed schema validation: ${result.error.message}`,
    );
  }

  return result.data;
}

/**
 * Write the default config file to .flowguard/config.json.
 *
 * Intended for the installer — creates a well-commented initial config.
 * Uses atomic write for consistency with all other FlowGuard file operations.
 *
 * @throws PersistenceError if the write fails.
 */
export async function writeDefaultConfig(worktree: string): Promise<void> {
  await ensureDir(worktree);
  const json = JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
  await atomicWrite(configPath(worktree), json);
}

// -- Internals ----------------------------------------------------------------

/** Type-safe ENOENT check. Shared by persistence and git adapters. */
export function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
