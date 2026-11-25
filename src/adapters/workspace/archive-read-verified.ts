/**
 * @module adapters/workspace/archive-read-verified
 * @description Read the canonical completion export together with its verified
 * snapshot contents.
 *
 * This is the ONLY reader that a read-only projection may use to make positive
 * evidence claims: it runs the canonical verifier
 * ({@link verifyCompletionExportCaptured}), requires the package to be the raw
 * completion export with an intact `.sha256` sidecar, and returns the session
 * state and audit trail extracted from the same private snapshot that was
 * verified. A caller can therefore never derive "verified" evidence from a
 * mutable workspace file, a redacted sharing archive, or an unverified package.
 *
 * The sidecar requirement is deliberately independent of the archive
 * verifier's strictness mode: a missing sidecar is a warning for general
 * archive inspection, but it is a hard block for evidence-to-control mapping.
 *
 * @version v1
 */

import { type ArchiveFinding, type ArchiveManifest } from '../../archive/types.js';
import type { SessionState } from '../../state/schema.js';
import type { AuditEvent } from '../../state/evidence.js';
import {
  verifyCompletionExportCaptured,
  type CapturedArchiveVerification,
  type VerifiedArchiveCapture,
} from './archive-verify-chain.js';
import { validateFingerprint, validateSessionId } from './types.js';

/** Fail-closed reasons a completion export cannot back verified evidence. */
export type VerifiedExportBlockCode =
  | 'PACKAGE_MISSING'
  | 'PACKAGE_UNVERIFIABLE'
  | 'SESSION_MISMATCH'
  | 'SIDECAR_REQUIRED'
  | 'SIDECAR_MISMATCH'
  | 'NOT_RAW_EVIDENCE_EXPORT'
  | 'STATE_UNAVAILABLE'
  | 'AUDIT_UNAVAILABLE';

/** A verified raw completion export and the contents of its verified snapshot. */
export interface VerifiedCompletionExport {
  readonly kind: 'verified';
  /**
   * Provenance brand: the contents below were read from the verified snapshot,
   * not from any mutable workspace file. Projections require this literal.
   */
  readonly integrity: 'verified_archive_snapshot';
  readonly manifest: ArchiveManifest;
  readonly state: SessionState;
  readonly events: readonly AuditEvent[];
  /** SHA-256 of the snapshot tarball the sidecar was compared against. */
  readonly packageSha256: string;
  /** Digest recorded in the `.sha256` sidecar (equal to `packageSha256`). */
  readonly sidecarSha256: string;
}

/** A blocked read: no positive evidence may be derived from this package. */
export interface BlockedCompletionExport {
  readonly kind: 'blocked';
  readonly code: VerifiedExportBlockCode;
  readonly reason: string;
  readonly findings: readonly ArchiveFinding[];
}

export type VerifiedCompletionExportRead = VerifiedCompletionExport | BlockedCompletionExport;

function blocked(
  run: CapturedArchiveVerification,
  code: VerifiedExportBlockCode,
  reason: string,
): BlockedCompletionExport {
  return { kind: 'blocked', code, reason, findings: run.verification.findings };
}

/**
 * Deterministic, privacy-preserving summary of the block for CLI output. The
 * original codes and messages are preserved; only their count is compacted.
 */
export function describeBlockedExport(read: BlockedCompletionExport): string {
  const errors = read.findings.filter((finding) => finding.severity === 'error');
  const detail = errors.length > 0 ? ` (${errors.map((finding) => finding.code).join(', ')})` : '';
  return `${read.code}: ${read.reason}${detail}`;
}

type PackageIdentityCheck =
  | { readonly kind: 'blocked'; readonly result: BlockedCompletionExport }
  | {
      readonly kind: 'ok';
      readonly manifest: ArchiveManifest;
      readonly state: SessionState;
      readonly capture: VerifiedArchiveCapture;
    };

/** Package existence, verification, session identity, and raw-evidence shape. */
function checkPackageIdentity(
  run: CapturedArchiveVerification,
  validSessionId: string,
): PackageIdentityCheck {
  const { capture, verification } = run;
  if (capture.packageSha256 === null) {
    return {
      kind: 'blocked',
      result: blocked(
        run,
        'PACKAGE_MISSING',
        'No completion export package could be read for this session',
      ),
    };
  }
  if (verification.manifest === null || !verification.passed) {
    return {
      kind: 'blocked',
      result: blocked(
        run,
        'PACKAGE_UNVERIFIABLE',
        'The completion export failed archive verification',
      ),
    };
  }
  const manifest = verification.manifest;
  if (manifest.sessionId !== validSessionId) {
    return {
      kind: 'blocked',
      result: blocked(
        run,
        'SESSION_MISMATCH',
        `The package names session '${manifest.sessionId}', not the requested session`,
      ),
    };
  }
  if (manifest.rawIncluded !== true || manifest.redactionMode !== 'none') {
    return {
      kind: 'blocked',
      result: blocked(
        run,
        'NOT_RAW_EVIDENCE_EXPORT',
        'The package is a redacted sharing archive, not the raw completion export',
      ),
    };
  }
  if (capture.state === null) {
    return {
      kind: 'blocked',
      result: blocked(run, 'STATE_UNAVAILABLE', 'The verified snapshot carries no readable state'),
    };
  }
  const state = capture.state;
  if (
    state.binding.hostSessionId !== manifest.sessionId ||
    state.binding.fingerprint !== manifest.fingerprint
  ) {
    return {
      kind: 'blocked',
      result: blocked(
        run,
        'SESSION_MISMATCH',
        'The verified state binding does not match the package identity',
      ),
    };
  }
  return { kind: 'ok', manifest, state, capture };
}

/**
 * Read and verify the immutable completion export for a session.
 *
 * Fail-closed order:
 * 1. the snapshot must exist and verify with zero error findings
 * 2. the manifest must name the requested session and the state's binding must
 *    agree on session and fingerprint
 * 3. the package must be the raw completion export (`rawIncluded` + no
 *    redaction)
 * 4. the `.sha256` sidecar must exist, parse, and equal the snapshot digest
 * 5. state and audit trail must be present in the verified snapshot
 */
export async function readVerifiedCompletionExport(
  fingerprint: string,
  sessionId: string,
): Promise<VerifiedCompletionExportRead> {
  validateFingerprint(fingerprint);
  const validSessionId = validateSessionId(sessionId);

  const run = await verifyCompletionExportCaptured(fingerprint, validSessionId);
  const identity = checkPackageIdentity(run, validSessionId);
  if (identity.kind === 'blocked') return identity.result;
  const { capture } = identity;

  if (!capture.sidecarPresent || capture.sidecarSha256 === null) {
    return blocked(run, 'SIDECAR_REQUIRED', 'The completion export has no valid .sha256 sidecar');
  }
  if (capture.sidecarSha256 !== capture.packageSha256) {
    return blocked(
      run,
      'SIDECAR_MISMATCH',
      'The .sha256 sidecar does not match the verified snapshot digest',
    );
  }
  if (capture.events === null) {
    return blocked(
      run,
      'AUDIT_UNAVAILABLE',
      'The verified snapshot carries no readable audit trail',
    );
  }

  return {
    kind: 'verified',
    integrity: 'verified_archive_snapshot',
    manifest: identity.manifest,
    state: identity.state,
    events: capture.events,
    packageSha256: capture.packageSha256,
    sidecarSha256: capture.sidecarSha256,
  };
}
