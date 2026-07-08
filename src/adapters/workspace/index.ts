/**
 * @module workspace
 * @description Barrel export for the workspace module.
 *
 * Re-exports all public API from focused modules:
 * - types.ts      — types, WorkspaceError, validation, constants
 * - fingerprint.ts — URL canonicalization, path normalization, fingerprint computation
 * - init.ts       — path resolution (SSOT), initialization, workspace info, session pointer
 * - archive.ts                   — session archive build pipeline
 * - archive-files.ts             — internal filesystem helpers shared by archive build and verification
 * - archive-verify-manifest.ts   — file-inventory and digest verification
 * - archive-verify-chain.ts      — audit-chain, timestamp, content-digest verification (owns verifyArchive)
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
} from './types.js';

// ── Fingerprint ──────────────────────────────────────────────────────────────
export {
  canonicalizeOriginUrl,
  normalizeForFingerprint,
  computeFingerprint,
  computeFingerprintFromRemote,
  computeFingerprintFromPath,
} from './fingerprint.js';

// ── Path Resolution & Initialization ─────────────────────────────────────────
export {
  workspacesHome,
  configRoot,
  workspaceDir,
  sessionDir,
  ensureWorkspace,
  initWorkspace,
  readWorkspaceInfo,
  writeSessionPointer,
  readSessionPointer,
} from './init.js';

// ── Evidence Artifacts ────────────────────────────────────────────────────────
export {
  materializeEvidenceArtifacts,
  materializeReviewCardArtifact,
  verifyEvidenceArtifacts,
} from './evidence-artifacts.js';

// ── Archive ──────────────────────────────────────────────────────────────────
export { archiveSession } from './archive.js';
export { verifyArchive } from './archive-verify-chain.js';
