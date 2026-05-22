/**
 * @module workspace/archive-timestamp-verification
 * @description Archive-level cryptographic TSA token verification.
 */

import type { ArchiveFinding, ArchiveManifest } from '../../archive/types.js';
import type { AuditEvent } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import { PkijsTimestampVerifier } from '../../audit/rfc3161-pkijs-verifier.js';
import { verifyTimestampTokensForEvents } from '../../audit/timestamp-token-verification.js';

export async function verifyArchiveTimestampTokens(input: {
  readonly events: readonly AuditEvent[];
  readonly state: SessionState | null;
  readonly manifest: ArchiveManifest;
  readonly findings: ArchiveFinding[];
}): Promise<void> {
  const timestampPolicy = input.state?.policySnapshot.audit.timestampAssurance;
  const trustAnchors = timestampPolicy?.trustAnchors ?? [];
  if (trustAnchors.length === 0) return;

  const result = await verifyTimestampTokensForEvents({
    events: input.events,
    verifier: new PkijsTimestampVerifier(),
    trustAnchors,
  });

  for (const finding of result.findings) {
    input.findings.push({
      code: 'tsa_verification_failed',
      severity:
        timestampPolicy?.strict || input.manifest.policyMode === 'regulated' ? 'error' : 'warning',
      message: `TSA token verification failed for audit event index ${finding.index}: ${finding.reason}`,
      file: 'audit.jsonl',
    });
  }
}
