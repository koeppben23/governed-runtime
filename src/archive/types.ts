/**
 * @module archive/types
 * @description Zod schemas and TypeScript types for archive hardening.
 *
 * Single source of truth for:
 * - ArchiveManifest: integrity manifest embedded in session archives
 * - ArchiveVerification: structured verification result
 * - ArchiveFinding: individual finding from verification
 * - ArchiveFindingCode: typed finding codes
 *
 * Namespace separation: archive types live here, NOT in discovery/types.
 * Archive is not discovery — they are independently evolving concerns.
 *
 * Dependency: imports only from shared zero-dependency identifiers. This module
 * is a leaf — it MUST NOT import from state/adapters/config (architecture
 * contract). PolicyMode SSOT validation lives in the verifier (adapter layer).
 *
 * @version v2
 */

import { z } from 'zod';
import { FINGERPRINT_PATTERN } from '../shared/flowguard-identifiers.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Manifest schema version.
 *
 * v2 (breaking, no legacy path): folds integrity-relevant metadata (policy mode,
 * audit head/count, identity) into the content digest and adds the audit
 * truncation anchor. v1 archives fail closed via schema validation.
 */
export const ARCHIVE_MANIFEST_SCHEMA_VERSION = 'archive-manifest.v2' as const;

/**
 * Manifest policy mode value — a closed, fail-closed vocabulary.
 *
 * This is a deliberate LOCAL enum, not an import of the PolicyMode SSOT
 * (`state/policy-mode`): `archive/types` is a leaf module and MUST NOT import
 * from `state` (architecture contract). The governed-mode members
 * (`solo`/`team`/`team-ci`/`regulated`) MUST stay in sync with `POLICY_MODES`;
 * the extra `unknown` sentinel is written only when no policy snapshot was
 * resolved at archive time. Any value outside this set fails schema validation
 * (`manifest_parse_error`, fail-closed). The authoritative check — that the
 * recorded mode equals the integrity-covered `state.policySnapshot.mode` — is
 * additionally enforced by the verifier (adapter layer) via cross-check.
 */
export const MANIFEST_POLICY_MODE_UNKNOWN = 'unknown' as const;
export const MANIFEST_POLICY_MODES = [
  'solo',
  'team',
  'team-ci',
  'regulated',
  MANIFEST_POLICY_MODE_UNKNOWN,
] as const;
export const ManifestPolicyModeSchema = z.enum(MANIFEST_POLICY_MODES);
export type ManifestPolicyMode = z.infer<typeof ManifestPolicyModeSchema>;

// ─── Finding Codes ────────────────────────────────────────────────────────────

/**
 * Typed finding codes for archive verification.
 *
 * Each code maps to a specific integrity violation or anomaly:
 * - missing_manifest: archive-manifest.json not found in archive
 * - manifest_parse_error: manifest JSON is malformed or schema-invalid
 * - missing_file: file listed in manifest is missing from archive
 * - unexpected_file: file in archive not listed in manifest
 * - file_digest_mismatch: SHA-256 of file content doesn't match manifest
 * - content_digest_mismatch: overall content digest doesn't match manifest
 * - manifest_policy_mode_mismatch: manifest.policyMode disagrees with the
 *   integrity-covered state.policySnapshot.mode (strict-mode tamper attempt)
 * - audit_chain_truncated: actual audit head/count disagrees with the manifest
 *   anchor (tail truncation undetectable by chain verification alone)
 * - archive_checksum_missing: .tar.gz.sha256 sidecar file not found
 * - archive_checksum_mismatch: archive file hash doesn't match sidecar
 * - audit_chain_invalid: current-format audit trail hash-chain verification failed
 *   because the v2 chain was tampered, reordered, inserted, or deleted
 * - audit_chain_legacy_format: chained pre-v2 audit trail requires migration or
 *   explicit weak legacy verification and is not v2 tamper evidence
 * - audit_chain_unsupported_format: audit trail declares an unknown chain format
 * - snapshot_missing: discovery or profile-resolution snapshot not found
 * - state_missing: session-state.json not found in archive
 * - state_invalid: session-state.json exists but cannot be parsed or validated
 */
export const ArchiveFindingCodeSchema = z.enum([
  'missing_manifest',
  'manifest_parse_error',
  'missing_file',
  'unexpected_file',
  'file_digest_mismatch',
  'content_digest_mismatch',
  'manifest_policy_mode_mismatch',
  'audit_chain_truncated',
  'archive_checksum_missing',
  'archive_checksum_mismatch',
  'audit_chain_invalid',
  'audit_chain_legacy_format',
  'audit_chain_unsupported_format',
  'snapshot_missing',
  'state_missing',
  'state_invalid',
  'timestamp_unanchored',
  'tsa_verification_failed',
  'artifact_binding_missing',
  'artifact_binding_mismatch',
]);
export type ArchiveFindingCode = z.infer<typeof ArchiveFindingCodeSchema>;

// ─── Finding Severity ─────────────────────────────────────────────────────────

/** Severity of an archive verification finding. */
export const ArchiveFindingSeveritySchema = z.enum(['error', 'warning', 'info']);
export type ArchiveFindingSeverity = z.infer<typeof ArchiveFindingSeveritySchema>;

// ─── Archive Finding ──────────────────────────────────────────────────────────

/** A single finding from archive verification. */
export const ArchiveFindingSchema = z.object({
  code: ArchiveFindingCodeSchema,
  severity: ArchiveFindingSeveritySchema,
  message: z.string(),
  /** Optional: the file path this finding relates to. */
  file: z.string().optional(),
});
export type ArchiveFinding = z.infer<typeof ArchiveFindingSchema>;

// ─── Archive Manifest ─────────────────────────────────────────────────────────

/**
 * Archive manifest — integrity metadata for a session archive.
 *
 * Written BEFORE the tar is created and included as part of the archive.
 * Enables post-hoc verification of archive completeness and integrity.
 *
 * - includedFiles: sorted list of relative paths in the archive
 * - fileDigests: SHA-256 of each file's content, keyed by relative path
 * - contentDigest: SHA-256 over the sorted file digests AND an integrity header
 *   of security-relevant metadata (policy mode, audit head/count, identity).
 *   See {@link ./content-digest.ts} for the canonical formula.
 *
 * Distinction:
 * - contentDigest = hash over file digests + integrity header (inside manifest)
 * - .tar.gz.sha256 = hash of the archive file itself (sidecar, verifiable from outside)
 */
export const ArchiveManifestSchema = z.object({
  schemaVersion: z.literal(ARCHIVE_MANIFEST_SCHEMA_VERSION),
  createdAt: z.string().datetime(),
  // Session id as recorded by archiveSession (validateSessionId). OpenCode
  // provides opaque ids like "ses_...", not UUIDs, so the manifest must accept
  // any non-empty id — NOT z.string().uuid(), which rejected every real
  // OpenCode session and made verifyArchive emit manifest_parse_error ->
  // archiveStatus:"failed" on otherwise-valid archives. Path-traversal safety
  // is enforced by validateSessionId at write time, not by this schema.
  sessionId: z.string().min(1),
  fingerprint: z.string().regex(FINGERPRINT_PATTERN),
  policyMode: ManifestPolicyModeSchema,
  profileId: z.string().min(1),
  /** SHA-256 digest of the discovery result (or null if discovery was skipped). */
  discoveryDigest: z.string().nullable(),
  /**
   * Last audit chain hash at archive time. Anchors the audit tail so truncation
   * (which a prefix-valid chain cannot reveal) is detectable. 'genesis' when no
   * chained events exist.
   */
  auditChainHead: z.string().min(1),
  /** Number of audit events at archive time. Pairs with auditChainHead. */
  auditEventCount: z.number().int().nonnegative(),
  /** Sorted list of relative file paths included in the archive. */
  includedFiles: z.array(z.string()),
  /** SHA-256 digest of each file, keyed by relative path. */
  fileDigests: z.record(z.string(), z.string()),
  /** SHA-256 over the sorted file digests plus the integrity header (see content-digest.ts). */
  contentDigest: z.string(),
  /** Export redaction mode used while creating archive artifacts. */
  redactionMode: z.enum(['none', 'basic', 'strict']).optional(),
  /** Whether raw (non-redacted) artifacts were included in archive export. */
  rawIncluded: z.boolean().optional(),
  /** Artifact paths generated as redacted export surfaces. */
  redactedArtifacts: z.array(z.string()).optional(),
  /** Artifact paths intentionally excluded from export. */
  excludedFiles: z.array(z.string()).optional(),
  /** Risk markers attached to this archive export. */
  riskFlags: z.array(z.string()).optional(),
});
export type ArchiveManifest = z.infer<typeof ArchiveManifestSchema>;

// ─── Archive Verification ─────────────────────────────────────────────────────

/**
 * Structured result of archive verification.
 *
 * - passed: true if no error-severity findings exist
 * - findings: all findings (errors, warnings, info)
 * - manifest: the parsed manifest (if available)
 */
export const ArchiveVerificationSchema = z.object({
  passed: z.boolean(),
  findings: z.array(ArchiveFindingSchema),
  /** The parsed manifest, if it was found and valid. */
  manifest: ArchiveManifestSchema.nullable(),
  verifiedAt: z.string().datetime(),
});
export type ArchiveVerification = z.infer<typeof ArchiveVerificationSchema>;
