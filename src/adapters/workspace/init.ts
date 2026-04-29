/**
 * @module workspace/init
 * @description Path resolution (SSOT), workspace initialization, workspace info,
 * metadata consistency checks, and session pointer management.
 *
 * Authority model:
 * - SSOT: worktree + sessionID → fingerprint → sessionDir
 * - SESSION_POINTER.json is a non-authoritative diagnostic cache
 * - This module is the ONLY module that constructs workspace/session paths
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { isEnoent } from '../persistence.js';

import {
  WORKSPACE_FILE,
  WORKSPACE_SCHEMA_VERSION,
  POINTER_FILE,
  POINTER_SCHEMA,
  WorkspaceError,
  validateFingerprint,
  validateSessionId,
  type FingerprintResult,
  type WorkspaceInfo,
  type SessionPointer,
} from './types.js';
import { computeFingerprint } from './fingerprint.js';

// -- Path Resolution (SSOT) ---------------------------------------------------

/**
 * Resolve the global workspaces home directory.
 * Location: ~/.config/opencode/workspaces/
 *
 * Uses OPENCODE_CONFIG_DIR if set (for testing/custom setups),
 * otherwise defaults to ~/.config/opencode.
 *
 * Safety guard: when FLOWGUARD_REQUIRE_TEST_CONFIG_DIR is set,
 * OPENCODE_CONFIG_DIR is mandatory.  This prevents accidental writes
 * to the production workspace registry during tests, E2E, and CI.
 */
export function workspacesHome(): string {
  if (process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR) {
    if (!process.env.OPENCODE_CONFIG_DIR) {
      throw new Error(
        `OPENCODE_CONFIG_DIR is not set but FLOWGUARD_REQUIRE_TEST_CONFIG_DIR is active. ` +
          `Test environments must set OPENCODE_CONFIG_DIR to an isolated temporary directory.`,
      );
    }
    assertSafeConfigDir(process.env.OPENCODE_CONFIG_DIR);
  }
  const configRoot =
    process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');
  return path.join(configRoot, 'workspaces');
}

/**
 * Assert that a config directory path is a safe temporary location.
 *
 * Uses path.resolve + path.relative to verify the directory is under
 * the OS temp root, not a substring-based heuristic.
 */
function assertSafeConfigDir(dir: string): void {
  const tmpRoot = path.resolve(os.tmpdir());
  const resolvedDir = path.resolve(dir);
  // Shortest path: if resolvedDir IS tmpRoot, ok too
  if (resolvedDir === tmpRoot) return;
  const rel = path.relative(tmpRoot, resolvedDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `OPENCODE_CONFIG_DIR (${resolvedDir}) must be under the OS temp directory (${tmpRoot}) ` +
        `when FLOWGUARD_REQUIRE_TEST_CONFIG_DIR is active.`,
    );
  }
}

/**
 * Resolve the global config root (parent of workspaces/).
 * Used for SESSION_POINTER.json location.
 */
export function configRoot(): string {
  return process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');
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
  return path.join(workspacesHome(), fingerprint, 'sessions', sessionId);
}

// -- Workspace Initialization -------------------------------------------------

/**
 * Initialize (or open) a workspace root. Idempotent — does NOT create a session.
 *
 * Creates the workspace directory structure (sessions/, discovery/) and
 * materializes workspace.json if it does not already exist.
 *
 * This is the SSOT for workspace-root creation. Used by both the installer
 * and the runtime session bootstrap path.
 *
 * @param worktree - Git worktree root path.
 * @returns Workspace info, fingerprint, and workspace directory path.
 * @throws WorkspaceError on fingerprinting failure, metadata mismatch, or I/O error.
 */
export async function ensureWorkspace(
  worktree: string,
): Promise<{ info: WorkspaceInfo; fingerprint: string; workspaceDir: string }> {
  const fpResult = await computeFingerprint(worktree);
  const fp = fpResult.fingerprint;
  const wsDir = workspaceDir(fp);

  try {
    await fs.mkdir(path.join(wsDir, 'sessions'), { recursive: true });
    await fs.mkdir(path.join(wsDir, 'discovery'), { recursive: true });
  } catch (err) {
    throw new WorkspaceError(
      'INIT_FAILED',
      `Failed to create workspace directories: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const wsFilePath = path.join(wsDir, WORKSPACE_FILE);
  const existing = await readWorkspaceFile(wsFilePath);

  if (existing) {
    assertMetadataConsistency(existing, fpResult);
    return { info: existing, fingerprint: fp, workspaceDir: wsDir };
  }

  const info: WorkspaceInfo = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    fingerprint: fp,
    materialClass: fpResult.materialClass,
    canonicalRemote: fpResult.canonicalRemote,
    worktreePath: fpResult.normalizedRoot,
    createdAt: new Date().toISOString(),
  };

  try {
    await fs.writeFile(wsFilePath, JSON.stringify(info, null, 2), 'utf-8');
  } catch (err) {
    throw new WorkspaceError(
      'WRITE_FAILED',
      `Failed to write workspace.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { info, fingerprint: fp, workspaceDir: wsDir };
}

/**
 * Initialize workspace and session directory. Idempotent.
 *
 * Calls ensureWorkspace() for the workspace root, then creates the session
 * subdirectory. This is the canonical runtime bootstrap path used by
 * /hydrate and /start.
 *
 * Invariants:
 * - Multiple calls with same (worktree, sessionId) produce no side effects
 * - Existing workspace.json is validated, not overwritten
 * - Existing session directory is reused
 * - Missing directories are created
 * - Metadata mismatch on canonicalRemote with same fingerprint → fail-closed
 *
 * Creates:
 * - ~/.config/opencode/workspaces/{fingerprint}/
 * - ~/.config/opencode/workspaces/{fingerprint}/workspace.json
 * - ~/.config/opencode/workspaces/{fingerprint}/sessions/{sessionId}/
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
  const ws = await ensureWorkspace(worktree);
  const sessDir = sessionDir(ws.fingerprint, validSessionId);

  try {
    await fs.mkdir(sessDir, { recursive: true });
  } catch (err) {
    throw new WorkspaceError(
      'INIT_FAILED',
      `Failed to create session directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    info: ws.info,
    fingerprint: ws.fingerprint,
    sessionDir: sessDir,
    workspaceDir: ws.workspaceDir,
  };
}

// -- Workspace Info -----------------------------------------------------------

/**
 * Read workspace.json from a workspace directory.
 * Returns null if the file does not exist.
 * Throws on I/O or parse errors.
 */
async function readWorkspaceFile(filePath: string): Promise<WorkspaceInfo | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Basic shape validation (not full Zod — workspace.json is ours, not user-facing)
    if (
      typeof parsed.fingerprint !== 'string' ||
      typeof parsed.materialClass !== 'string' ||
      typeof parsed.createdAt !== 'string'
    ) {
      throw new WorkspaceError('READ_FAILED', 'workspace.json has invalid shape');
    }
    return parsed as WorkspaceInfo;
  } catch (err) {
    if (isEnoent(err)) return null;
    if (err instanceof WorkspaceError) throw err;
    throw new WorkspaceError(
      'READ_FAILED',
      `Failed to read workspace.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read workspace info for a given fingerprint.
 * Returns null if workspace doesn't exist.
 */
export async function readWorkspaceInfo(fingerprint: string): Promise<WorkspaceInfo | null> {
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
function assertMetadataConsistency(existing: WorkspaceInfo, current: FingerprintResult): void {
  // Hard conflict: same fingerprint but different canonical remote
  // This means either hash collision (astronomically unlikely) or tampering
  if (
    existing.canonicalRemote !== null &&
    current.canonicalRemote !== null &&
    existing.canonicalRemote !== current.canonicalRemote
  ) {
    throw new WorkspaceError(
      'WORKSPACE_MISMATCH',
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
    await fs.writeFile(pointerPath, JSON.stringify(pointer, null, 2), 'utf-8');
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
    const raw = await fs.readFile(pointerPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.schema !== POINTER_SCHEMA) return null;
    return parsed as SessionPointer;
  } catch {
    return null;
  }
}
