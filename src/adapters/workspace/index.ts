/**
 * @module workspace
 * @description Barrel export for the workspace module.
 *
 * Re-exports all public API from focused modules:
 * - types.ts      — types, WorkspaceError, validation, constants
 * - fingerprint.ts — URL canonicalization, path normalization, fingerprint computation
 * - init.ts       — path resolution (SSOT), initialization, workspace info, session pointer
 * - archive.ts    — session archiving and verification
 *
 * All existing imports from "./workspace" or "../adapters/workspace" resolve
 * to this barrel unchanged because TypeScript resolves directory imports to index.ts.
 *
 * @version v1
 */

// ── Types & Validation ───────────────────────────────────────────────────────
export {
  type MaterialClass,
  type FingerprintResult,
  type WorkspaceInfo,
  type SessionPointer,
  WorkspaceError,
  validateFingerprint,
  validateSessionId,
} from "./types";

// ── Fingerprint ──────────────────────────────────────────────────────────────
export {
  canonicalizeOriginUrl,
  normalizeForFingerprint,
  computeFingerprint,
  computeFingerprintFromRemote,
  computeFingerprintFromPath,
} from "./fingerprint";

// ── Path Resolution & Initialization ─────────────────────────────────────────
export {
  workspacesHome,
  configRoot,
  workspaceDir,
  sessionDir,
  initWorkspace,
  readWorkspaceInfo,
  writeSessionPointer,
  readSessionPointer,
} from "./init";

// ── Archive ──────────────────────────────────────────────────────────────────
export {
  archiveSession,
  verifyArchive,
} from "./archive";
