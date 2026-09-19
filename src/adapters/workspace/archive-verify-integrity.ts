/**
 * @module adapters/workspace/archive-verify-integrity
 * @description Archive integrity orchestration stage: strictness resolution,
 * manifest policy-mode cross-check, audit-chain verification, content digest,
 * checksum sidecar, and external publication binding.
 *
 * @version v1
 */

import { type ArchiveManifest, type ArchiveFinding } from '../../archive/types.js';
import { computeArchiveContentDigest } from '../../archive/content-digest.js';
import { resolveArchiveStrictness } from './archive-verify-helpers.js';
import {
  verifyAuditChainIntegrity,
  verifyManifestPolicyMode,
} from './archive-verify-audit-chain.js';
import { verifyArchiveChecksum } from './archive-verify-checksum.js';
import { verifyExternalPublicationBinding } from './archive-verify-publication.js';

function addContentDigestFindings(manifest: ArchiveManifest, findings: ArchiveFinding[]): void {
  // Content digest is ALWAYS verified — including an empty archive (no included
  // files). The integrity header (policy mode, audit anchor, identity) is part of
  // the digest, so a tampered header on a 0-file manifest must still fail closed.
  let computedContentDigest: string | null = null;
  try {
    computedContentDigest = computeArchiveContentDigest({
      includedFiles: manifest.includedFiles,
      fileDigests: manifest.fileDigests,
      policyMode: manifest.policyMode,
      auditChainHead: manifest.auditChainHead,
      auditEventCount: manifest.auditEventCount,
      schemaVersion: manifest.schemaVersion,
      layoutVersion: manifest.layoutVersion,
      sessionId: manifest.sessionId,
      fingerprint: manifest.fingerprint,
      discoveryDigest: manifest.discoveryDigest,
    });
  } catch (error) {
    findings.push({
      code: 'content_digest_mismatch',
      severity: 'error',
      message: `Content digest could not be computed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  if (computedContentDigest !== null && computedContentDigest !== manifest.contentDigest) {
    findings.push({
      code: 'content_digest_mismatch',
      severity: 'error',
      message:
        'Content digest does not match computed value from file digests and integrity header',
    });
  }
}

export async function verifyArchiveIntegrity(
  location: { sessDir: string; fingerprint: string; validSessionId: string },
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
  state: import('../../state/schema.js').SessionState | null,
  archive: {
    readonly snapshotPath: string;
    readonly archivePath: string;
    readonly checksumSidecarPath: string;
  },
): Promise<void> {
  const { sessDir } = location;
  // Strict authority and completeness checks run BEFORE the content digest so a
  // mode/anchor tamper surfaces explicitly rather than only as a digest mismatch.
  const strictness = resolveArchiveStrictness(state);
  const { strict } = strictness;
  if (!strictness.policyStateResolved) {
    findings.push({
      code: 'policy_state_unresolved',
      severity: 'error',
      message:
        'Trusted policy state is unavailable; archive verification is running in fail-closed strict mode',
      file: 'state/session-state.json',
    });
  }
  verifyManifestPolicyMode(manifest, state, findings);
  await verifyAuditChainIntegrity(sessDir, manifest, findings, state, strict);
  addContentDigestFindings(manifest, findings);

  await verifyArchiveChecksum(archive.snapshotPath, archive.checksumSidecarPath, strict, findings);
  await verifyExternalPublicationBinding(location, manifest, archive, findings);
}
