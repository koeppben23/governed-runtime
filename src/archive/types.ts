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
 * Dependency: leaf module — no imports from other FlowGuard modules.
 *
 * @version v1
 */

import { z } from "zod";

// ─── Constants ────────────────────────────────────────────────────────────────

export const ARCHIVE_MANIFEST_SCHEMA_VERSION =
  "archive-manifest.v1" as const;

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
 * - archive_checksum_missing: .tar.gz.sha256 sidecar file not found
 * - archive_checksum_mismatch: archive file hash doesn't match sidecar
 * - snapshot_missing: discovery or profile-resolution snapshot not found
 * - state_missing: session-state.json not found in archive
 */
export const ArchiveFindingCodeSchema = z.enum([
  "missing_manifest",
  "manifest_parse_error",
  "missing_file",
  "unexpected_file",
  "file_digest_mismatch",
  "content_digest_mismatch",
  "archive_checksum_missing",
  "archive_checksum_mismatch",
  "snapshot_missing",
  "state_missing",
]);
export type ArchiveFindingCode = z.infer<typeof ArchiveFindingCodeSchema>;

// ─── Finding Severity ─────────────────────────────────────────────────────────

/** Severity of an archive verification finding. */
export const ArchiveFindingSeveritySchema = z.enum([
  "error",
  "warning",
  "info",
]);
export type ArchiveFindingSeverity = z.infer<
  typeof ArchiveFindingSeveritySchema
>;

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
 * - contentDigest: SHA-256 of the sorted, concatenated fileDigests values
 *   (deterministic aggregate hash)
 *
 * Distinction:
 * - contentDigest = hash over file digests (inside manifest, verifiable from content)
 * - .tar.gz.sha256 = hash of the archive file itself (sidecar, verifiable from outside)
 */
export const ArchiveManifestSchema = z.object({
  schemaVersion: z.literal(ARCHIVE_MANIFEST_SCHEMA_VERSION),
  createdAt: z.string().datetime(),
  sessionId: z.string().uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{24}$/),
  policyMode: z.string().min(1),
  profileId: z.string().min(1),
  /** SHA-256 digest of the discovery result (or null if discovery was skipped). */
  discoveryDigest: z.string().nullable(),
  /** Sorted list of relative file paths included in the archive. */
  includedFiles: z.array(z.string()),
  /** SHA-256 digest of each file, keyed by relative path. */
  fileDigests: z.record(z.string(), z.string()),
  /** SHA-256 of the sorted, concatenated file digest values. */
  contentDigest: z.string(),
  /** Export redaction mode used while creating archive artifacts. */
  redactionMode: z.enum(["none", "basic", "strict"]).optional(),
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
