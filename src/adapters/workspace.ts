/**
 * @module workspace
 * @description Workspace registry — manages per-repository workspace directories
 * under the global OpenCode config root (~/.config/opencode/workspaces/).
 *
 * Responsibilities:
 * - Compute deterministic repository fingerprints (24 hex chars, SHA-256)
 * - Canonicalize git remote URLs for stable identity
 * - Resolve workspace and session directory paths (SSOT for all path construction)
 * - Initialize workspace + session directories idempotently
 * - Archive completed sessions as tar.gz
 * - Write/read non-authoritative session pointer for diagnostics
 * - Validate path segments (fingerprint, sessionId) before filesystem use
 * - Detect and handle workspace.json metadata mismatches
 *
 * Authority model:
 * - SSOT: worktree + sessionID → fingerprint → sessionDir
 * - SESSION_POINTER.json is a non-authoritative diagnostic cache
 * - workspace.ts is the ONLY module that constructs workspace/session paths
 *
 * Fingerprint algorithm (matches reference implementation):
 * - Remote canonical: SHA-256("repo:" + canonicalize(remoteUrl))[:24]
 * - Local path fallback: SHA-256("repo:local:" + normalize(worktreePath))[:24]
 *
 * @version v1
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { remoteOriginUrl } from "./git";

// -- Constants ----------------------------------------------------------------

/** Fingerprint length: 24 hex characters (96 bits). Matches reference. */
const FINGERPRINT_LENGTH = 24;

/** Regex for validating fingerprint format. */
const FINGERPRINT_RE = /^[0-9a-f]{24}$/;

/** Unsafe characters for path segments. */
const UNSAFE_PATH_CHARS_RE = /[\/\\:\0]/;

/** Workspace metadata filename. */
const WORKSPACE_FILE = "workspace.json";

/** Session pointer filename (global, non-authoritative). */
const POINTER_FILE = "SESSION_POINTER.json";

/** Workspace metadata schema version. */
const WORKSPACE_SCHEMA_VERSION = "v1";

/** Session pointer schema identifier. */
const POINTER_SCHEMA = "flowguard-session-pointer.v1";

// -- Types --------------------------------------------------------------------

/** Material class for fingerprint derivation. */
export type MaterialClass = "remote_canonical" | "local_path";

/** Result of fingerprint computation. */
export interface FingerprintResult {
  readonly fingerprint: string;
  readonly materialClass: MaterialClass;
  readonly canonicalRemote: string | null;
  readonly normalizedRoot: string;
}

/** Workspace metadata stored in workspace.json. */
export interface WorkspaceInfo {
  readonly schemaVersion: string;
  readonly fingerprint: string;
  readonly materialClass: MaterialClass;
  readonly canonicalRemote: string | null;
  readonly worktreePath: string;
  readonly createdAt: string;
}

/** Global session pointer (non-authoritative diagnostic cache). */
export interface SessionPointer {
  readonly schema: string;
  readonly activeRepoFingerprint: string;
  readonly activeSessionId: string;
  readonly activeSessionDir: string;
  readonly updatedAt: string;
}

// -- Error --------------------------------------------------------------------

/**
 * Typed workspace error.
 * Codes:
 * - INVALID_FINGERPRINT: fingerprint format validation failed
 * - INVALID_SESSION_ID: sessionId path-segment validation failed
 * - WORKSPACE_MISMATCH: existing workspace.json conflicts with current derivation
 * - INIT_FAILED: workspace/session directory creation failed
 * - ARCHIVE_FAILED: session archive creation failed
 * - READ_FAILED: workspace.json or pointer read failed
 * - WRITE_FAILED: workspace.json or pointer write failed
 */
export class WorkspaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

// -- Validation ---------------------------------------------------------------

/**
 * Validate fingerprint format: exactly 24 lowercase hex characters.
 * Fail-closed: rejects anything that doesn't match.
 *
 * @throws WorkspaceError with code INVALID_FINGERPRINT
 */
export function validateFingerprint(fingerprint: string): string {
  if (!FINGERPRINT_RE.test(fingerprint)) {
    throw new WorkspaceError(
      "INVALID_FINGERPRINT",
      `Invalid fingerprint format: expected 24 hex chars, got "${fingerprint}"`,
    );
  }
  return fingerprint;
}

/**
 * Validate sessionId as a safe filesystem path segment.
 * Rejects empty strings, path traversal, and unsafe characters.
 * OpenCode typically provides UUIDs, but we trust no input blindly.
 *
 * @throws WorkspaceError with code INVALID_SESSION_ID
 */
export function validateSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) {
    throw new WorkspaceError("INVALID_SESSION_ID", "Session ID is empty");
  }
  if (UNSAFE_PATH_CHARS_RE.test(trimmed)) {
    throw new WorkspaceError(
      "INVALID_SESSION_ID",
      `Session ID contains unsafe characters: "${trimmed}"`,
    );
  }
  if (trimmed === "." || trimmed === "..") {
    throw new WorkspaceError(
      "INVALID_SESSION_ID",
      "Session ID is a path traversal component",
    );
  }
  return trimmed;
}

// -- URL Canonicalization -----------------------------------------------------

/**
 * Canonicalize a git remote URL for stable fingerprint derivation.
 *
 * Algorithm (matches reference implementation):
 * 1. Convert SCP-style URLs (git@host:path) to ssh://git@host/path
 * 2. Parse via URL
 * 3. Casefold hostname (include port if non-default)
 * 4. Normalize path: replace backslashes, collapse slashes, strip .git, casefold
 * 5. Return canonical form: repo://<host><path>
 *
 * @param rawUrl - Raw remote URL from git (HTTPS, SSH, SCP-style, etc.)
 * @returns Canonical URL in the form "repo://<host><path>"
 */
export function canonicalizeOriginUrl(rawUrl: string): string {
  let url = rawUrl.trim();

  // SCP-style: git@github.com:org/repo.git → ssh://git@github.com/org/repo.git
  const scpMatch = url.match(/^([A-Za-z0-9._-]+@)?([A-Za-z0-9._-]+):(.+)$/);
  if (scpMatch && !url.includes("://")) {
    const user = scpMatch[1] ?? "";
    const host = scpMatch[2];
    const repoPath = scpMatch[3];
    url = `ssh://${user}${host}/${repoPath}`;
  }

  let hostname: string;
  let pathname: string;

  try {
    const parsed = new URL(url);
    // Casefold hostname; include port if present and non-default
    hostname = parsed.hostname.toLowerCase();
    if (parsed.port) {
      hostname += `:${parsed.port}`;
    }
    pathname = parsed.pathname;
  } catch {
    // Unparseable URL — use as-is with basic normalization
    hostname = "";
    pathname = url;
  }

  // Normalize path: replace backslashes, collapse multiple slashes
  pathname = pathname.replace(/\\/g, "/").replace(/\/+/g, "/");

  // Strip trailing slash (but keep leading /) — must happen before .git strip
  // so that "repo.git/" becomes "repo.git" which then becomes "repo"
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  // Strip trailing .git suffix
  if (pathname.endsWith(".git")) {
    pathname = pathname.slice(0, -4);
  }

  // Strip any trailing slash left after .git removal (e.g. "/org/.git" → "/org/")
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  // Ensure leading slash
  if (!pathname.startsWith("/")) {
    pathname = "/" + pathname;
  }

  // Casefold path for case-insensitive matching
  pathname = pathname.toLowerCase();

  return `repo://${hostname}${pathname}`;
}

// -- Path Normalization -------------------------------------------------------

/**
 * Normalize a filesystem path for deterministic fingerprint derivation.
 *
 * Algorithm (matches reference implementation):
 * 1. Resolve to absolute path
 * 2. Normalize (collapse .., remove redundant separators)
 * 3. Replace backslashes with forward slashes
 * 4. Casefold on Windows (case-insensitive filesystem)
 *
 * @param absPath - Absolute path to normalize.
 * @returns Normalized path string suitable for hashing.
 */
export function normalizeForFingerprint(absPath: string): string {
  let normalized = path.resolve(absPath);
  normalized = path.normalize(normalized);
  normalized = normalized.replace(/\\/g, "/");
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

// -- Fingerprint Computation --------------------------------------------------

/**
 * Compute the deterministic repository fingerprint.
 *
 * Two derivation paths:
 * 1. Remote canonical (preferred): SHA-256("repo:" + canonicalize(remoteUrl))[:24]
 * 2. Local path fallback: SHA-256("repo:local:" + normalize(worktreePath))[:24]
 *
 * The fingerprint is stable across:
 * - Different clones of the same remote (same fingerprint)
 * - Worktree path changes (if remote exists)
 * - OS normalization differences (casefolding, separators)
 *
 * @param worktree - Git worktree root path.
 * @returns FingerprintResult with fingerprint, material class, and derivation metadata.
 */
export async function computeFingerprint(
  worktree: string,
): Promise<FingerprintResult> {
  const remote = await remoteOriginUrl(worktree);

  if (remote) {
    const canonical = canonicalizeOriginUrl(remote);
    const material = `repo:${canonical}`;
    const fingerprint = crypto
      .createHash("sha256")
      .update(material, "utf-8")
      .digest("hex")
      .slice(0, FINGERPRINT_LENGTH);
    return {
      fingerprint,
      materialClass: "remote_canonical",
      canonicalRemote: canonical,
      normalizedRoot: normalizeForFingerprint(worktree),
    };
  }

  // Fallback: no remote — use normalized local path
  const normalizedRoot = normalizeForFingerprint(worktree);
  const material = `repo:local:${normalizedRoot}`;
  const fingerprint = crypto
    .createHash("sha256")
    .update(material, "utf-8")
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
  return {
    fingerprint,
    materialClass: "local_path",
    canonicalRemote: null,
    normalizedRoot,
  };
}

/**
 * Compute fingerprint synchronously from a known canonical remote URL.
 * Used when the remote URL is already available (avoids async git call).
 */
export function computeFingerprintFromRemote(canonicalRemote: string): string {
  const material = `repo:${canonicalRemote}`;
  return crypto
    .createHash("sha256")
    .update(material, "utf-8")
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

/**
 * Compute fingerprint synchronously from a normalized local path.
 * Used when there is no remote (fallback path).
 */
export function computeFingerprintFromPath(normalizedPath: string): string {
  const material = `repo:local:${normalizedPath}`;
  return crypto
    .createHash("sha256")
    .update(material, "utf-8")
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

// -- Path Resolution (SSOT) ---------------------------------------------------

/**
 * Resolve the global workspaces home directory.
 * Location: ~/.config/opencode/workspaces/
 *
 * Uses OPENCODE_CONFIG_DIR if set (for testing/custom setups),
 * otherwise defaults to ~/.config/opencode.
 */
export function workspacesHome(): string {
  const configRoot =
    process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode");
  return path.join(configRoot, "workspaces");
}

/**
 * Resolve the global config root (parent of workspaces/).
 * Used for SESSION_POINTER.json location.
 */
export function configRoot(): string {
  return process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode");
}

/**
 * Resolve the workspace directory for a given fingerprint.
 * SSOT: This is the ONLY function that constructs workspace paths.
 *
 * @param fingerprint - Validated 24-hex fingerprint.
 * @returns Absolute path to the workspace directory.
 * @throws WorkspaceError if fingerprint is invalid.
 */
export function workspaceDir(fingerprint: string): string {
  validateFingerprint(fingerprint);
  return path.join(workspacesHome(), fingerprint);
}

/**
 * Resolve the session directory for a given fingerprint + session ID.
 * SSOT: This is the ONLY function that constructs session paths.
 *
 * @param fingerprint - Validated 24-hex fingerprint.
 * @param sessionId - Validated session ID (safe path segment).
 * @returns Absolute path to the session directory.
 * @throws WorkspaceError if fingerprint or sessionId is invalid.
 */
export function sessionDir(fingerprint: string, sessionId: string): string {
  validateFingerprint(fingerprint);
  validateSessionId(sessionId);
  return path.join(workspacesHome(), fingerprint, "sessions", sessionId);
}

// -- Workspace Initialization -------------------------------------------------

/**
 * Initialize workspace and session directory. Idempotent.
 *
 * Invariants:
 * - Multiple calls with same (worktree, sessionId) produce no side effects
 * - Existing workspace.json is validated, not overwritten
 * - Existing session directory is reused
 * - Missing directories are created
 * - Metadata mismatch on canonicalRemote with same fingerprint → fail-closed (hash collision or tampering)
 * - Metadata mismatch on materialClass → warning logged, existing workspace.json preserved
 *
 * Creates:
 * - ~/.config/opencode/workspaces/{fingerprint}/
 * - ~/.config/opencode/workspaces/{fingerprint}/workspace.json
 * - ~/.config/opencode/workspaces/{fingerprint}/sessions/{sessionId}/
 * - ~/.config/opencode/workspaces/{fingerprint}/logs/
 * - ~/.config/opencode/workspaces/{fingerprint}/discovery/
 *
 * @param worktree - Git worktree root path.
 * @param sessionId - OpenCode session ID.
 * @returns WorkspaceInfo metadata (from existing workspace.json or newly created).
 * @throws WorkspaceError on validation failure, mismatch, or I/O error.
 */
export async function initWorkspace(
  worktree: string,
  sessionId: string,
): Promise<{ info: WorkspaceInfo; fingerprint: string; sessionDir: string; workspaceDir: string }> {
  const validSessionId = validateSessionId(sessionId);
  const fpResult = await computeFingerprint(worktree);
  const fp = fpResult.fingerprint;
  const wsDir = workspaceDir(fp);
  const sessDir = sessionDir(fp, validSessionId);

  try {
    // Create workspace directory structure (idempotent via recursive mkdir)
    await fs.mkdir(path.join(wsDir, "sessions"), { recursive: true });
    await fs.mkdir(path.join(wsDir, "logs"), { recursive: true });
    await fs.mkdir(path.join(wsDir, "discovery"), { recursive: true });
    await fs.mkdir(sessDir, { recursive: true });
  } catch (err) {
    throw new WorkspaceError(
      "INIT_FAILED",
      `Failed to create workspace directories: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Read or create workspace.json
  const wsFilePath = path.join(wsDir, WORKSPACE_FILE);
  const existing = await readWorkspaceFile(wsFilePath);

  if (existing) {
    // Validate metadata consistency
    assertMetadataConsistency(existing, fpResult);
    return { info: existing, fingerprint: fp, sessionDir: sessDir, workspaceDir: wsDir };
  }

  // Create new workspace.json
  const info: WorkspaceInfo = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    fingerprint: fp,
    materialClass: fpResult.materialClass,
    canonicalRemote: fpResult.canonicalRemote,
    worktreePath: fpResult.normalizedRoot,
    createdAt: new Date().toISOString(),
  };

  try {
    await fs.writeFile(wsFilePath, JSON.stringify(info, null, 2), "utf-8");
  } catch (err) {
    throw new WorkspaceError(
      "WRITE_FAILED",
      `Failed to write workspace.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { info, fingerprint: fp, sessionDir: sessDir, workspaceDir: wsDir };
}

// -- Workspace Info -----------------------------------------------------------

/**
 * Read workspace.json from a workspace directory.
 * Returns null if the file does not exist.
 * Throws on I/O or parse errors.
 */
async function readWorkspaceFile(filePath: string): Promise<WorkspaceInfo | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    // Basic shape validation (not full Zod — workspace.json is ours, not user-facing)
    if (
      typeof parsed.fingerprint !== "string" ||
      typeof parsed.materialClass !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      throw new WorkspaceError(
        "READ_FAILED",
        "workspace.json has invalid shape",
      );
    }
    return parsed as WorkspaceInfo;
  } catch (err) {
    if (isEnoent(err)) return null;
    if (err instanceof WorkspaceError) throw err;
    throw new WorkspaceError(
      "READ_FAILED",
      `Failed to read workspace.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read workspace info for a given fingerprint.
 * Returns null if workspace doesn't exist.
 */
export async function readWorkspaceInfo(
  fingerprint: string,
): Promise<WorkspaceInfo | null> {
  validateFingerprint(fingerprint);
  const wsDir = workspaceDir(fingerprint);
  return readWorkspaceFile(path.join(wsDir, WORKSPACE_FILE));
}

// -- Metadata Consistency Check -----------------------------------------------

/**
 * Assert that existing workspace.json metadata is consistent with the
 * current fingerprint derivation.
 *
 * Rules:
 * - canonicalRemote mismatch with same fingerprint → fail-closed (hash collision or tampering)
 * - materialClass mismatch → allowed but signals a change (repo gained/lost remote)
 * - worktreePath mismatch → allowed (different clone, same remote = expected)
 *
 * @throws WorkspaceError with code WORKSPACE_MISMATCH on hard conflict.
 */
function assertMetadataConsistency(
  existing: WorkspaceInfo,
  current: FingerprintResult,
): void {
  // Hard conflict: same fingerprint but different canonical remote
  // This means either hash collision (astronomically unlikely) or tampering
  if (
    existing.canonicalRemote !== null &&
    current.canonicalRemote !== null &&
    existing.canonicalRemote !== current.canonicalRemote
  ) {
    throw new WorkspaceError(
      "WORKSPACE_MISMATCH",
      `Workspace fingerprint collision: existing canonicalRemote "${existing.canonicalRemote}" ` +
        `differs from current "${current.canonicalRemote}" for fingerprint "${current.fingerprint}". ` +
        `This indicates a hash collision or workspace tampering.`,
    );
  }
  // Soft conflicts (materialClass, worktreePath) are allowed — the workspace is still usable.
  // Doctor can surface these for diagnosis.
}

// -- Session Pointer (Non-Authoritative) --------------------------------------

/**
 * Write the global session pointer. Non-authoritative diagnostic cache.
 * Fire-and-forget: errors are swallowed (pointer is convenience, not SSOT).
 *
 * The pointer records the last known active session for diagnostic tools (doctor, debug).
 * It is NEVER used for routing or session resolution.
 * The authoritative path is always: worktree → computeFingerprint → sessionDir.
 */
export async function writeSessionPointer(
  fingerprint: string,
  sessionId: string,
  sessDir: string,
): Promise<void> {
  try {
    const pointer: SessionPointer = {
      schema: POINTER_SCHEMA,
      activeRepoFingerprint: fingerprint,
      activeSessionId: sessionId,
      activeSessionDir: sessDir,
      updatedAt: new Date().toISOString(),
    };
    const pointerPath = path.join(configRoot(), POINTER_FILE);
    await fs.mkdir(path.dirname(pointerPath), { recursive: true });
    await fs.writeFile(pointerPath, JSON.stringify(pointer, null, 2), "utf-8");
  } catch {
    // Swallow — pointer is non-authoritative convenience
  }
}

/**
 * Read the global session pointer. Non-authoritative.
 * Returns null if the pointer doesn't exist or is invalid.
 * Used only by doctor/debug — never for routing.
 */
export async function readSessionPointer(): Promise<SessionPointer | null> {
  try {
    const pointerPath = path.join(configRoot(), POINTER_FILE);
    const raw = await fs.readFile(pointerPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.schema !== POINTER_SCHEMA) return null;
    return parsed as SessionPointer;
  } catch {
    return null;
  }
}

// -- Session Archive ----------------------------------------------------------

/**
 * Archive a completed session as a tar.gz file.
 *
 * Creates: ~/.config/opencode/workspaces/{fingerprint}/sessions/archive/{sessionId}.tar.gz
 *
 * Uses the system `tar` command (available on Windows 10+, macOS, Linux).
 * The archive contains the full session directory contents.
 *
 * @param fingerprint - Validated workspace fingerprint.
 * @param sessionId - Session ID to archive.
 * @returns Absolute path to the created archive file.
 * @throws WorkspaceError if the session directory doesn't exist or archiving fails.
 */
export async function archiveSession(
  fingerprint: string,
  sessionId: string,
): Promise<string> {
  validateFingerprint(fingerprint);
  const validSessionId = validateSessionId(sessionId);

  const sessDir = sessionDir(fingerprint, validSessionId);
  const archiveDir = path.join(workspacesHome(), fingerprint, "sessions", "archive");
  const archivePath = path.join(archiveDir, `${validSessionId}.tar.gz`);

  // Verify session directory exists
  try {
    await fs.access(sessDir);
  } catch {
    throw new WorkspaceError(
      "ARCHIVE_FAILED",
      `Session directory does not exist: ${sessDir}`,
    );
  }

  // Create archive directory
  try {
    await fs.mkdir(archiveDir, { recursive: true });
  } catch (err) {
    throw new WorkspaceError(
      "ARCHIVE_FAILED",
      `Failed to create archive directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Create tar.gz using system tar (available on Windows 10+, macOS, Linux)
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    // Use -C to change to parent directory, archive the session subdirectory
    const sessionsParent = path.join(workspacesHome(), fingerprint, "sessions");
    await execFileAsync("tar", [
      "czf",
      archivePath,
      "-C",
      sessionsParent,
      validSessionId,
    ], {
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (err) {
    throw new WorkspaceError(
      "ARCHIVE_FAILED",
      `tar command failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return archivePath;
}

// -- Internals ----------------------------------------------------------------

/**
 * Check if an error is ENOENT (file not found).
 * Reused pattern from persistence.ts.
 */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
