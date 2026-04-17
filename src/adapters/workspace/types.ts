/**
 * @module workspace/types
 * @description Types, constants, error class, and validation for the workspace module.
 *
 * @version v1
 */

// -- Constants ----------------------------------------------------------------

/** Fingerprint length: 24 hex characters (96 bits). Matches reference. */
export const FINGERPRINT_LENGTH = 24;

/** Regex for validating fingerprint format. */
export const FINGERPRINT_RE = /^[0-9a-f]{24}$/;

/** Unsafe characters for path segments. */
export const UNSAFE_PATH_CHARS_RE = /[/\\:\0]/;

/** Workspace metadata filename. */
export const WORKSPACE_FILE = "workspace.json";

/** Session pointer filename (global, non-authoritative). */
export const POINTER_FILE = "SESSION_POINTER.json";

/** Workspace metadata schema version. */
export const WORKSPACE_SCHEMA_VERSION = "v1";

/** Session pointer schema identifier. */
export const POINTER_SCHEMA = "flowguard-session-pointer.v1";

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
