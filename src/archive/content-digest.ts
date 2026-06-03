/**
 * @module archive/content-digest
 * @description Single canonical authority for the archive content digest.
 *
 * The content digest binds two surfaces into one SHA-256:
 * 1. The sorted file digests (archive payload integrity).
 * 2. An integrity header of security-relevant manifest metadata.
 *
 * Folding the metadata into the digest closes the gap where unsigned manifest
 * fields (policy mode, audit head/count, identity) could be mutated without
 * detection. Any change to a covered field invalidates the digest (fail-closed).
 *
 * Pure module: no I/O, no logging, no side effects. Both the archive builder
 * and verifier call this so there is no parallel/duplicate digest formula.
 *
 * @version v1
 */

import * as crypto from 'node:crypto';

/**
 * Inputs to the archive content digest.
 *
 * Field set is intentionally explicit: adding a field here changes the digest
 * contract and MUST be accompanied by a manifest schema version bump.
 */
export interface ArchiveContentDigestInput {
  /** Sorted relative file paths included in the archive. */
  includedFiles: readonly string[];
  /** SHA-256 of each included file, keyed by relative path. */
  fileDigests: Readonly<Record<string, string>>;
  /** Policy mode that governed the session (integrity-covered). */
  policyMode: string;
  /** Last audit chain hash at archive time (truncation anchor). */
  auditChainHead: string;
  /** Number of audit events at archive time (truncation anchor). */
  auditEventCount: number;
  /** Manifest schema version. */
  schemaVersion: string;
  /** Session identifier. */
  sessionId: string;
  /** Workspace fingerprint. */
  fingerprint: string;
  /** Discovery result digest, or null if discovery was skipped. */
  discoveryDigest: string | null;
}

/**
 * Compute the deterministic archive content digest.
 *
 * The integrity header is serialized with a fixed key order so the digest is
 * stable across runs and platforms.
 */
export function computeArchiveContentDigest(input: ArchiveContentDigestInput): string {
  const sortedDigestValues = input.includedFiles
    .map((file) => input.fileDigests[file])
    .filter((digest): digest is string => Boolean(digest))
    .sort();

  const integrityHeader = JSON.stringify({
    schemaVersion: input.schemaVersion,
    sessionId: input.sessionId,
    fingerprint: input.fingerprint,
    policyMode: input.policyMode,
    discoveryDigest: input.discoveryDigest,
    auditChainHead: input.auditChainHead,
    auditEventCount: input.auditEventCount,
  });

  return crypto
    .createHash('sha256')
    .update(integrityHeader)
    .update('\n')
    .update(sortedDigestValues.join(''))
    .digest('hex');
}
