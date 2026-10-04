/**
 * @module adapters/workspace/archive-verify-helpers
 * @description Pure helper predicates and resolvers for archive verification.
 *
 * Every function in this module is a deterministic computation over its
 * inputs — no I/O, no logging, no telemetry, no external state mutation.
 * They are extracted from archive-verify-chain.ts so each can be unit-tested
 * independently.
 *
 * verifyArchive in archive-verify-chain.ts remains the single orchestrating
 * authority for archive verification.
 *
 * @version v1
 */

import { isPolicyMode } from '../../state/policy-mode.js';
import type { SessionState } from '../../state/schema.js';
import {
  ARTIFACT_BINDING_EVENT,
  ARTIFACT_BINDING_SCHEMA_VERSION,
  ARCHIVE_PUBLICATION_BINDING_EVENT,
  ARCHIVE_PUBLICATION_BINDING_SCHEMA_VERSION,
  type ArtifactBindingEntry,
  type ArchivePublicationBinding,
} from './archive-artifact-binding.js';
import type { ChainVerificationReason } from '../../audit/integrity.js';
import type { ArchiveFindingCode } from '../../archive/types.js';

/**
 * Fail-closed default: when the governed policy mode cannot be resolved from
 * integrity-covered state, verification runs strict. A resolvable non-regulated
 * mode is never escalated.
 */
export const STRICT_WHEN_MODE_UNRESOLVED = true;

export interface ArchiveStrictness {
  readonly strict: boolean;
  readonly policyStateResolved: boolean;
}

// ─── Artifact Binding ─────────────────────────────────────────────────────────

export function findBindingArtifacts(
  events: readonly Record<string, unknown>[],
): unknown[] | undefined {
  const binding = [...events].reverse().find((event) => event.event === ARTIFACT_BINDING_EVENT);
  const detail = binding?.detail as Record<string, unknown> | undefined;
  if (
    detail?.schemaVersion !== ARTIFACT_BINDING_SCHEMA_VERSION ||
    !Array.isArray(detail?.artifacts)
  )
    return undefined;
  return detail.artifacts as unknown[];
}

export function isArtifactBindingEntry(value: unknown): value is ArtifactBindingEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === 'string' &&
    entry.path.startsWith('artifacts/') &&
    typeof entry.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.sha256) &&
    (entry.artifactType === null || typeof entry.artifactType === 'string')
  );
}

export function findPublicationBinding(
  events: readonly Record<string, unknown>[],
  expected: ArchivePublicationBinding,
): boolean {
  const binding = [...events].reverse().find((event) => {
    const detail = event.detail as Record<string, unknown> | undefined;
    return (
      event.event === ARCHIVE_PUBLICATION_BINDING_EVENT &&
      detail?.schemaVersion === ARCHIVE_PUBLICATION_BINDING_SCHEMA_VERSION &&
      detail.archiveFile === expected.archiveFile
    );
  });
  const detail = binding?.detail as Record<string, unknown> | undefined;
  return (
    detail?.publicationId === expected.publicationId &&
    detail.archiveDigest === expected.archiveDigest &&
    detail.sidecarDigest === expected.sidecarDigest &&
    detail.manifestContentDigest === expected.manifestContentDigest
  );
}

export function lastPublicationBinding(
  events: readonly Record<string, unknown>[],
): ArchivePublicationBinding | undefined {
  const event = events.at(-1);
  if (event?.event !== ARCHIVE_PUBLICATION_BINDING_EVENT) return undefined;
  const detail = event.detail as Record<string, unknown> | undefined;
  if (
    detail?.schemaVersion !== ARCHIVE_PUBLICATION_BINDING_SCHEMA_VERSION ||
    typeof detail.publicationId !== 'string' ||
    typeof detail.archiveFile !== 'string' ||
    typeof detail.archiveDigest !== 'string' ||
    typeof detail.sidecarDigest !== 'string' ||
    typeof detail.manifestContentDigest !== 'string'
  )
    return undefined;
  return {
    publicationId: detail.publicationId,
    archiveFile: detail.archiveFile,
    archiveDigest: detail.archiveDigest,
    sidecarDigest: detail.sidecarDigest,
    manifestContentDigest: detail.manifestContentDigest,
  };
}

// ─── Audit Chain Predicates ────────────────────────────────────────────────────

export function hasTimestampEvidence(event: Record<string, unknown>): boolean {
  const evidence = event.timestampEvidence;
  return typeof evidence === 'object' && evidence !== null;
}

export function isCurrentChainIntegrityFailure(reason: ChainVerificationReason | null): boolean {
  return reason === 'CHAIN_BREAK' || reason === 'CLOCK_ANOMALY';
}

export function isAuditFormatFailure(reason: ChainVerificationReason | null): boolean {
  return reason === 'AUDIT_ENVELOPE_INVALID';
}

/**
 * A chain reason that reports PENDING cryptographic verification, not a
 * verification failure.
 *
 * The synchronous verifier cannot validate an RFC3161 token: it deliberately
 * refuses to trust the mutable cached `messageImprint` when a non-empty
 * `tokenDerBase64` is present, and defers to the asynchronous
 * `PkijsTimestampVerifier`. Projecting that deferral into a terminal
 * `tsa_verification_failed` finding made a valid, correctly signed token fail
 * the archive verification, because archive findings are append-only — a later
 * successful cryptographic verification cannot retract an earlier finding.
 *
 * Deferring is safe rather than fail-open: every event that produces this
 * reason carries a non-empty token, which is exactly the set
 * `verifyArchiveTimestampTokens` covers. With trust anchors configured it
 * verifies each token cryptographically; with none configured it reports
 * `tsa_verification_failed` for the presence of unverifiable TSA evidence. The
 * async layer is therefore the single authority for the verdict.
 */
export function isDeferredTimestampReason(reason: ChainVerificationReason | null): boolean {
  return reason === 'TOKEN_VERIFICATION_REQUIRED';
}

/**
 * Map a `readAuditTrail()` failure to its archive finding code. The read
 * boundary rejects every record that violates the canonical audit-chain.v3
 * envelope as `AUDIT_ENVELOPE_INVALID` — no legacy classification exists at
 * the trust boundary. Every other read failure falls back to the generic
 * chain-invalid bucket.
 */
export function auditReadFailureFindingCode(error: unknown): ArchiveFindingCode {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'AUDIT_ENVELOPE_INVALID') return 'audit_chain_invalid_event';
  return 'audit_chain_invalid';
}

/**
 * Map a TERMINAL timestamp verification reason to its archive finding code.
 *
 * Never call this for a deferred reason — see `isDeferredTimestampReason`.
 * `TOKEN_VERIFICATION_REQUIRED` is deliberately absent: it states that
 * cryptographic verification has not run yet, and mapping it here is what
 * turned pending verification into a permanent failure.
 */
export function timestampFindingCode(reason: ChainVerificationReason | null): ArchiveFindingCode {
  if (reason === 'TSA_MESSAGE_IMPRINT_MISMATCH') return 'tsa_verification_failed';
  if (reason === 'TSA_EVIDENCE_DOWNGRADED') return 'tsa_evidence_downgraded';
  return 'timestamp_unanchored';
}

// ─── Policy Mode ──────────────────────────────────────────────────────────────

export function resolveArchiveStrictness(state: SessionState | null): ArchiveStrictness {
  const mode = state?.policySnapshot?.mode;
  if (!isPolicyMode(mode)) {
    return { strict: STRICT_WHEN_MODE_UNRESOLVED, policyStateResolved: false };
  }
  return { strict: mode === 'regulated', policyStateResolved: true };
}

export function resolveStrictMode(state: SessionState | null): boolean {
  return resolveArchiveStrictness(state).strict;
}
