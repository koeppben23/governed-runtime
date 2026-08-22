/**
 * @module workspace/archive-timestamp-verification
 * @description Archive-level cryptographic TSA token verification.
 */

import type { ArchiveFinding, ArchiveManifest } from '../../archive/types.js';
import type { AuditEvent } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import { PkijsTimestampVerifier } from '../../audit/rfc-3161-pkijs-verifier.js';
import { verifyTimestampTokensForEvents } from '../../audit/timestamp-token-verification.js';

function eventHasTsaEvidence(event: AuditEvent): boolean {
  const evidence = event.timestampEvidence as Record<string, unknown> | undefined;
  return typeof evidence?.tsa === 'object' && evidence.tsa !== null;
}

export async function verifyArchiveTimestampTokens(input: {
  readonly events: readonly AuditEvent[];
  readonly state: SessionState | null;
  readonly manifest: ArchiveManifest;
  readonly findings: ArchiveFinding[];
  /**
   * Trusted strictness authority (AR2): the caller's `resolveStrictMode(state)`
   * resolution, shared with the chain verification. The archive manifest is
   * cross-checked elsewhere and is NEVER a severity authority.
   */
  readonly strict: boolean;
}): Promise<void> {
  const timestampPolicy = input.state?.policySnapshot.audit.timestampAssurance;
  const trustAnchors = timestampPolicy?.trustAnchors ?? [];
  const severity: 'error' | 'warning' = input.strict ? 'error' : 'warning';

  if (trustAnchors.length === 0) {
    if (input.events.some(eventHasTsaEvidence)) {
      input.findings.push({
        code: 'tsa_verification_failed',
        severity,
        message: 'TSA evidence is present but no timestamp trust anchors are configured',
        file: 'audit.jsonl',
      });
    }
    return;
  }

  const result = await verifyTimestampTokensForEvents({
    events: input.events,
    verifier: new PkijsTimestampVerifier(),
    trustAnchors,
  });

  for (const finding of result.findings) {
    input.findings.push({
      code: 'tsa_verification_failed',
      severity,
      message: `TSA token verification failed for audit event index ${finding.index}: ${finding.reason}`,
      file: 'audit.jsonl',
    });
  }
}
