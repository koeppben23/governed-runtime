/**
 * @module persistence
 * @description Atomic file I/O for FlowGuard session and workspace data.
 *
 * This is the ONLY module that touches the filesystem for FlowGuard state.
 * All FlowGuard files live under the workspace registry:
 *
 *   ~/.config/opencode/workspaces/{fingerprint}/
 *   +-- workspace.json          # Workspace metadata (managed by workspace.ts)
 *   +-- config.json             # Per-workspace configuration
 *   +-- logs/                   # Per-workspace logs
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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SessionState } from "../state/schema";
import { AuditEvent, ReviewReport } from "../state/evidence";
import {
  DiscoveryResultSchema,
  ProfileResolutionSchema,
  type DiscoveryResult,
  type ProfileResolution,
} from "../discovery/types";
import {
  FlowGuardConfigSchema,
  DEFAULT_CONFIG,
  type FlowGuardConfig,
} from "../config/flowguard-config";

// -- Constants ----------------------------------------------------------------

const STATE_FILE = "session-state.json";
const REPORT_FILE = "review-report.json";
const AUDIT_FILE = "audit.jsonl";
const CONFIG_FILE = "config.json";

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

/** Resolve the config file path within a workspace directory. */
export function configPath(workspaceDir: string): string {
  return path.join(workspaceDir, CONFIG_FILE);
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
 * Ensure a directory exists. Idempotent.
 * Uses recursive mkdir -- safe to call even if parent dirs are missing.
 */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
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
 * 2. Creates session directory if missing
 * 3. Uses atomic write (temp -> rename)
 * 4. Pretty-prints JSON (2-space indent) for human readability
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param state - SessionState to persist.
 * @throws PersistenceError if validation fails or write fails.
 */
export async function writeState(
  sessionDir: string,
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

  await ensureDir(sessionDir);
  const json = JSON.stringify(result.data, null, 2) + "\n";
  await atomicWrite(statePath(sessionDir), json);
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
  } catch {
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
export async function writeReport(
  sessionDir: string,
  report: ReviewReport,
): Promise<void> {
  const result = ReviewReport.safeParse(report);
  if (!result.success) {
    throw new PersistenceError(
      "SCHEMA_VALIDATION_FAILED",
      `Refusing to persist invalid report: ${result.error.message}`,
    );
  }

  await ensureDir(sessionDir);
  const json = JSON.stringify(result.data, null, 2) + "\n";
  await atomicWrite(reportPath(sessionDir), json);
}

/**
 * Read the latest review report. Returns null if none exists.
 *
 * @param sessionDir - Absolute path to the session directory.
 */
export async function readReport(
  sessionDir: string,
): Promise<ReviewReport | null> {
  let raw: string;
  try {
    raw = await fs.readFile(reportPath(sessionDir), "utf-8");
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
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param event - AuditEvent to append.
 */
export async function appendAuditEvent(
  sessionDir: string,
  event: AuditEvent,
): Promise<void> {
  const result = AuditEvent.safeParse(event);
  if (!result.success) {
    throw new PersistenceError(
      "SCHEMA_VALIDATION_FAILED",
      `Refusing to append invalid audit event: ${result.error.message}`,
    );
  }

  await ensureDir(sessionDir);
  const line = JSON.stringify(result.data) + "\n";
  await fs.appendFile(auditPath(sessionDir), line, "utf-8");
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
    raw = await fs.readFile(auditPath(sessionDir), "utf-8");
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
 * Read the FlowGuard config from {workspaceDir}/config.json.
 *
 * Always returns a fully normalized FlowGuardConfig:
 * - If the file does not exist -> returns DEFAULT_CONFIG (all defaults applied).
 * - If the file exists and is valid -> returns Zod-parsed config (defaults filled).
 * - If the file exists but is invalid JSON -> throws PersistenceError(PARSE_FAILED).
 * - If the file exists but fails schema validation -> throws PersistenceError(SCHEMA_VALIDATION_FAILED).
 * - If the file cannot be read -> throws PersistenceError(READ_FAILED).
 *
 * Design: readConfig never returns null. Every caller sees a complete config
 * object with all fields populated -- no defensive checks needed downstream.
 *
 * @param workspaceDir - Absolute path to the workspace directory.
 */
export async function readConfig(workspaceDir: string): Promise<FlowGuardConfig> {
  const filePath = configPath(workspaceDir);

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
 * Write the default config file to {workspaceDir}/config.json.
 *
 * Intended for the installer -- creates a well-commented initial config.
 * Uses atomic write for consistency with all other FlowGuard file operations.
 *
 * @param workspaceDir - Absolute path to the workspace directory.
 * @throws PersistenceError if the write fails.
 */
export async function writeDefaultConfig(workspaceDir: string): Promise<void> {
  await ensureDir(workspaceDir);
  const json = JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
  await atomicWrite(configPath(workspaceDir), json);
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
export async function writeDiscovery(
  workspaceDir: string,
  result: DiscoveryResult,
): Promise<void> {
  const parsed = DiscoveryResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new PersistenceError(
      "SCHEMA_VALIDATION_FAILED",
      `DiscoveryResult failed schema validation: ${parsed.error.message}`,
    );
  }
  const dir = path.join(workspaceDir, "discovery");
  await ensureDir(dir);
  const json = JSON.stringify(parsed.data, null, 2) + "\n";
  await atomicWrite(path.join(dir, "discovery.json"), json);
}

/**
 * Read a DiscoveryResult from {workspaceDir}/discovery/discovery.json.
 *
 * Returns null if the file does not exist.
 * Schema-validated on read (fail-closed on corruption).
 *
 * @param workspaceDir - Absolute path to the workspace directory.
 */
export async function readDiscovery(
  workspaceDir: string,
): Promise<DiscoveryResult | null> {
  const filePath = path.join(workspaceDir, "discovery", "discovery.json");
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw new PersistenceError(
      "READ_FAILED",
      `Failed to read discovery file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PersistenceError(
      "PARSE_FAILED",
      `Discovery file is not valid JSON`,
    );
  }

  const parsed = DiscoveryResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new PersistenceError(
      "SCHEMA_VALIDATION_FAILED",
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
      "SCHEMA_VALIDATION_FAILED",
      `ProfileResolution failed schema validation: ${parsed.error.message}`,
    );
  }
  const dir = path.join(workspaceDir, "discovery");
  await ensureDir(dir);
  const json = JSON.stringify(parsed.data, null, 2) + "\n";
  await atomicWrite(path.join(dir, "profile-resolution.json"), json);
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
      "SCHEMA_VALIDATION_FAILED",
      `Discovery snapshot failed schema validation: ${parsed.error.message}`,
    );
  }
  await ensureDir(sessionDir);
  const json = JSON.stringify(parsed.data, null, 2) + "\n";
  await atomicWrite(path.join(sessionDir, "discovery-snapshot.json"), json);
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
      "SCHEMA_VALIDATION_FAILED",
      `Profile resolution snapshot failed schema validation: ${parsed.error.message}`,
    );
  }
  await ensureDir(sessionDir);
  const json = JSON.stringify(parsed.data, null, 2) + "\n";
  await atomicWrite(
    path.join(sessionDir, "profile-resolution-snapshot.json"),
    json,
  );
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
