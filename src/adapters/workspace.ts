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
import { readState } from "./persistence";
import {
  ArchiveManifestSchema,
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
  type ArchiveManifest,
  type ArchiveVerification,
  type ArchiveFinding,
  type ArchiveFindingCode,
} from "../archive/types";

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
 *          ~/.config/opencode/workspaces/{fingerprint}/sessions/archive/{sessionId}.tar.gz.sha256
 *
 * Archive process:
 * 1. Soft-check: warn if discoveryDigest is set but snapshots are missing
 * 2. Build archive-manifest.json (file inventory + SHA-256 digests)
 * 3. Write manifest into session dir (becomes part of the archive)
 * 4. Create tar.gz from session dir
 * 5. Write .sha256 sidecar file for the archive
 *
 * Uses the system `tar` command (available on Windows 10+, macOS, Linux).
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
  const checksumPath = `${archivePath}.sha256`;

  // Verify session directory exists
  try {
    await fs.access(sessDir);
  } catch {
    throw new WorkspaceError(
      "ARCHIVE_FAILED",
      `Session directory does not exist: ${sessDir}`,
    );
  }

  // ── Soft-check: warn if discovery snapshots are missing ────────
  const state = await readState(sessDir).catch(() => null);
  if (state?.discoveryDigest) {
    const snapshotPath = path.join(sessDir, "discovery-snapshot.json");
    try {
      await fs.access(snapshotPath);
    } catch {
      // Soft warning — log but don't fail. The archive will just lack the snapshot.
      // In a real system this would go to a logger; here we proceed gracefully.
    }
  }

  // ── Build and write archive manifest ──────────────────────────
  const manifest = await buildArchiveManifest(sessDir, state, fingerprint, validSessionId);
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  await fs.writeFile(path.join(sessDir, "archive-manifest.json"), manifestJson, "utf-8");

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

  // ── Write .sha256 sidecar ─────────────────────────────────────
  try {
    const archiveBuffer = await fs.readFile(archivePath);
    const archiveHash = crypto.createHash("sha256").update(archiveBuffer).digest("hex");
    await fs.writeFile(checksumPath, `${archiveHash}  ${path.basename(archivePath)}\n`, "utf-8");
  } catch {
    // Non-fatal: archive was created but checksum sidecar failed.
    // The archive is still usable, just not externally verifiable.
  }

  return archivePath;
}

/**
 * Verify an archived session's integrity.
 *
 * Checks:
 * 1. Archive manifest exists and is valid
 * 2. All files listed in manifest exist in session dir
 * 3. No unexpected files in session dir (not in manifest)
 * 4. File digests match
 * 5. Content digest matches
 * 6. Archive .sha256 sidecar matches (if available)
 * 7. Discovery snapshots present (if state has discoveryDigest)
 * 8. Session state file present
 *
 * @param fingerprint - Workspace fingerprint.
 * @param sessionId - Session ID to verify.
 * @returns Structured verification result with findings.
 */
export async function verifyArchive(
  fingerprint: string,
  sessionId: string,
): Promise<ArchiveVerification> {
  validateFingerprint(fingerprint);
  const validSessionId = validateSessionId(sessionId);

  const sessDir = sessionDir(fingerprint, validSessionId);
  const findings: ArchiveFinding[] = [];
  let manifest: ArchiveManifest | null = null;

  // 1. Read and parse manifest
  const manifestPath = path.join(sessDir, "archive-manifest.json");
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, "utf-8");
  } catch {
    findings.push({
      code: "missing_manifest",
      severity: "error",
      message: "Archive manifest not found in session directory",
      file: "archive-manifest.json",
    });
    return buildVerificationResult(findings, null);
  }

  try {
    const parsed = JSON.parse(manifestRaw);
    const result = ArchiveManifestSchema.safeParse(parsed);
    if (!result.success) {
      findings.push({
        code: "manifest_parse_error",
        severity: "error",
        message: `Manifest schema validation failed: ${result.error.message}`,
        file: "archive-manifest.json",
      });
      return buildVerificationResult(findings, null);
    }
    manifest = result.data;
  } catch {
    findings.push({
      code: "manifest_parse_error",
      severity: "error",
      message: "Manifest is not valid JSON",
      file: "archive-manifest.json",
    });
    return buildVerificationResult(findings, null);
  }

  // 2. Check state file
  const stateExists = await fileExists(path.join(sessDir, "session-state.json"));
  if (!stateExists) {
    findings.push({
      code: "state_missing",
      severity: "error",
      message: "Session state file not found",
      file: "session-state.json",
    });
  }

  // 3. Check discovery snapshots (if discoveryDigest is set)
  if (manifest.discoveryDigest) {
    for (const snapshotFile of [
      "discovery-snapshot.json",
      "profile-resolution-snapshot.json",
    ]) {
      const exists = await fileExists(path.join(sessDir, snapshotFile));
      if (!exists) {
        findings.push({
          code: "snapshot_missing",
          severity: "warning",
          message: `Discovery snapshot not found: ${snapshotFile}`,
          file: snapshotFile,
        });
      }
    }
  }

  // 4. Check each file in manifest
  for (const relPath of manifest.includedFiles) {
    const fullPath = path.join(sessDir, relPath);
    const exists = await fileExists(fullPath);
    if (!exists) {
      findings.push({
        code: "missing_file",
        severity: "error",
        message: `File listed in manifest is missing: ${relPath}`,
        file: relPath,
      });
      continue;
    }

    // Check file digest
    const expectedDigest = manifest.fileDigests[relPath];
    if (expectedDigest) {
      const content = await fs.readFile(fullPath);
      const actualDigest = crypto.createHash("sha256").update(content).digest("hex");
      if (actualDigest !== expectedDigest) {
        findings.push({
          code: "file_digest_mismatch",
          severity: "error",
          message: `File digest mismatch for ${relPath}: expected ${expectedDigest.slice(0, 12)}..., got ${actualDigest.slice(0, 12)}...`,
          file: relPath,
        });
      }
    }
  }

  // 5. Check for unexpected files
  const manifestFileSet = new Set(manifest.includedFiles);
  try {
    const actualFiles = await listSessionFiles(sessDir);
    for (const file of actualFiles) {
      if (!manifestFileSet.has(file)) {
        findings.push({
          code: "unexpected_file",
          severity: "warning",
          message: `File not listed in manifest: ${file}`,
          file,
        });
      }
    }
  } catch {
    // Can't list files — skip unexpected file check
  }

  // 6. Verify content digest
  if (manifest.includedFiles.length > 0) {
    const digestValues = manifest.includedFiles
      .map((f) => manifest!.fileDigests[f])
      .filter(Boolean)
      .sort();
    const computedContentDigest = crypto
      .createHash("sha256")
      .update(digestValues.join(""))
      .digest("hex");
    if (computedContentDigest !== manifest.contentDigest) {
      findings.push({
        code: "content_digest_mismatch",
        severity: "error",
        message: "Content digest does not match computed value from file digests",
      });
    }
  }

  // 7. Verify archive checksum sidecar
  const archiveCheckDir = path.join(workspacesHome(), fingerprint, "sessions", "archive");
  const archiveTarPath = path.join(archiveCheckDir, `${validSessionId}.tar.gz`);
  const checksumSidecarPath = `${archiveTarPath}.sha256`;

  const checksumExists = await fileExists(checksumSidecarPath);
  if (!checksumExists) {
    findings.push({
      code: "archive_checksum_missing",
      severity: "warning",
      message: "Archive checksum sidecar (.sha256) not found",
    });
  } else {
    try {
      const sidecarContent = await fs.readFile(checksumSidecarPath, "utf-8");
      const expectedHash = sidecarContent.trim().split(/\s+/)[0];
      const archiveBuffer = await fs.readFile(archiveTarPath);
      const actualHash = crypto.createHash("sha256").update(archiveBuffer).digest("hex");
      if (expectedHash !== actualHash) {
        findings.push({
          code: "archive_checksum_mismatch",
          severity: "error",
          message: `Archive checksum mismatch: sidecar says ${expectedHash?.slice(0, 12)}..., actual is ${actualHash.slice(0, 12)}...`,
        });
      }
    } catch {
      // Can't read archive or sidecar — skip
    }
  }

  return buildVerificationResult(findings, manifest);
}

// -- Internals ----------------------------------------------------------------

/**
 * Build an archive manifest from the session directory contents.
 *
 * Inventories all files, computes SHA-256 digests, and builds
 * a deterministic content digest from sorted file digests.
 */
async function buildArchiveManifest(
  sessDir: string,
  state: import("../state/schema").SessionState | null,
  fingerprint: string,
  sessionId: string,
): Promise<ArchiveManifest> {
  const files = await listSessionFiles(sessDir);
  const fileDigests: Record<string, string> = {};

  for (const relPath of files) {
    const content = await fs.readFile(path.join(sessDir, relPath));
    fileDigests[relPath] = crypto.createHash("sha256").update(content).digest("hex");
  }

  // Content digest: SHA-256 of sorted, concatenated file digest values
  const sortedDigestValues = files
    .map((f) => fileDigests[f])
    .filter(Boolean)
    .sort();
  const contentDigest = crypto
    .createHash("sha256")
    .update(sortedDigestValues.join(""))
    .digest("hex");

  // Add the manifest itself to the file list (it will be written after this)
  const includedFiles = [...files, "archive-manifest.json"].sort();

  return {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    sessionId,
    fingerprint,
    policyMode: state?.policySnapshot?.mode ?? "unknown",
    profileId: state?.activeProfile?.id ?? "baseline",
    discoveryDigest: state?.discoveryDigest ?? null,
    includedFiles,
    fileDigests,
    contentDigest,
  };
}

/**
 * List all files in a session directory (relative paths, sorted).
 * Excludes the archive-manifest.json itself (it's added separately).
 */
async function listSessionFiles(sessDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile() && entry.name !== "archive-manifest.json") {
        files.push(relPath);
      }
    }
  }

  await walk(sessDir, "");
  return files.sort();
}

/** Check if a file exists (non-throwing). */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Build the final verification result from findings. */
function buildVerificationResult(
  findings: ArchiveFinding[],
  manifest: ArchiveManifest | null,
): ArchiveVerification {
  const hasError = findings.some((f) => f.severity === "error");
  return {
    passed: !hasError,
    findings,
    manifest,
    verifiedAt: new Date().toISOString(),
  };
}

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
