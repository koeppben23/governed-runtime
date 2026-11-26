/**
 * @module audit/iso27001/evidence
 * @description Evidence-binding types for the ISO/IEC 27001:2022 projection.
 *
 * The projection is pure: it never reads the workspace, the live session, or
 * the archive. It receives exactly two evidence inputs:
 *
 * - {@link VerifiedEvidenceSnapshot}: contents of the canonical completion
 *   export, read from the same private snapshot the archive verifier checked.
 *   The `integrity` literal brands the provenance; only
 *   `readVerifiedCompletionExport` (adapters) produces it in production.
 * - {@link LiveExportBinding}: a deliberately minimal projection of the current
 *   (mutable) workspace session. It may ONLY feed the `export.completion`
 *   selector and can never make any other selector verified.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { AuditEvent } from '../../state/evidence.js';

/** Provenance brand for contents read from a verified archive snapshot. */
export const VERIFIED_ARCHIVE_SNAPSHOT = 'verified_archive_snapshot' as const;

/**
 * The verified completion-export snapshot.
 *
 * All identity fields are taken from the archive manifest and the verified
 * state; `fileDigests` is `manifest.fileDigests`, so every evidence reference
 * can name the exact archive member and its manifest digest.
 */
export interface VerifiedEvidenceSnapshot {
  readonly integrity: typeof VERIFIED_ARCHIVE_SNAPSHOT;
  /** Package/directory session identity (host session id). */
  readonly sessionId: string;
  /** Workspace fingerprint from the archive manifest. */
  readonly fingerprint: string;
  /** SHA-256 of the exported tarball (the snapshot the sidecar covers). */
  readonly packageSha256: string;
  /** Digest recorded in the `.sha256` sidecar (equal to `packageSha256`). */
  readonly sidecarSha256: string;
  /** Manifest content digest (sorted file digests + integrity header). */
  readonly manifestContentDigest: string;
  /** Archive manifest schema version, e.g. `archive-manifest.v4`. */
  readonly manifestSchemaVersion: string;
  /** Policy mode recorded in the manifest. */
  readonly manifestPolicyMode: string;
  /** Audit chain head anchored in the manifest. */
  readonly auditChainHead: string;
  /** Audit event count anchored in the manifest. */
  readonly auditEventCount: number;
  /** Manifest file digests by archive-relative path. */
  readonly fileDigests: Readonly<Record<string, string>>;
  readonly state: SessionState;
  readonly events: readonly AuditEvent[];
}

/**
 * Minimal live-workspace binding for the `export.completion` selector.
 *
 * `exportCompletionPackageDigest` comes from live
 * `SessionState.exportCompletionEvidence.packageDigest`. Both are mutable and
 * therefore reported as `live_binding` evidence only.
 *
 * `liveChainVerified` and `materializedTransitionAt` are NOT raw facts: the
 * reader only sets them after the canonical chain verification
 * (`verifyChain` with the expected FlowGuard session) passed AND the live
 * trail extends the verified archive anchor (prefix head equals the manifest
 * anchor). A live materialization event on a foreign session, a broken chain,
 * or a forked trail that does not extend the verified prefix can therefore
 * never produce positive evidence.
 */
export interface LiveExportBinding {
  readonly stateAvailable: boolean;
  readonly exportCompletionPackageDigest: string | null;
  /** Canonical session-bound chain validity plus archive-anchor extension. */
  readonly liveChainVerified: boolean;
  /**
   * Occurrence time of the canonical `EXPORT_READY → COMPLETE` materialization
   * event inside the verified live extension; `null` without one.
   */
  readonly materializedTransitionAt: string | null;
}
