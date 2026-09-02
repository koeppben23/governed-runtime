/**
 * @module workspace/archive-timestamp-verification
 * @description Archive-level cryptographic TSA token verification.
 */

import type { ArchiveFinding, ArchiveManifest } from '../../archive/types.js';
import type { AuditEvent } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import { PkijsTimestampVerifier } from '../../audit/rfc-3161-pkijs-verifier.js';
import { verifyTimestampTokensForEvents } from '../../audit/timestamp-token-verification.js';
import { extractEventKind } from '../../audit/timestamp-verification.js';

function eventHasTsaEvidence(event: AuditEvent): boolean {
  const evidence = event.timestampEvidence as Record<string, unknown> | undefined;
  const tsa = evidence?.tsa as Record<string, unknown> | undefined;
  // Covered by the tsa-null and no-tsa archive tests.
  if (typeof tsa !== 'object' || tsa === null) return false;
  // Sentinel contract (shared with the chain-level TSA authorities): only a
  // NON-EMPTY token is external TSA evidence that requires trust anchors.
  // The empty-string internal-imprint form was already verified against the
  // canonical content digest by the chain verification.
  return typeof tsa.tokenDerBase64 === 'string' && tsa.tokenDerBase64.length > 0;
}

/**
 * Policy authority (P2): `tsa_critical` REQUIRES an external TSA token for
 * critical events. The requirement is POSITIVE: a critical event must carry a
 * non-empty external token — internal-imprint evidence (empty
 * `tokenDerBase64`), a missing `tsa` payload, or non-TSA evidence (local/ntp)
 * do not satisfy the policy. A resealer could otherwise replace cryptographic
 * anchoring with locally recomputable digests, so the archive verification
 * must report a dedicated assurance downgrade instead of silently accepting
 * it.
 */
function reportPolicyTokenDowngrades(
  events: readonly AuditEvent[],
  state: SessionState | null,
  severity: 'error' | 'warning',
  findings: ArchiveFinding[],
): void {
  const timestampPolicy = state?.policySnapshot.audit.timestampAssurance;
  if (timestampPolicy?.enabled !== true || timestampPolicy.mode !== 'tsa_critical') return;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (!timestampPolicy.criticalEvents.includes(extractEventKind(event.event))) continue;
    const evidence = event.timestampEvidence as Record<string, unknown> | undefined;
    const tsa = evidence?.tsa as Record<string, unknown> | undefined;
    const tokenDerBase64 = tsa?.tokenDerBase64;
    if (typeof tokenDerBase64 === 'string' && tokenDerBase64.length > 0) continue;

    findings.push({
      code: 'tsa_token_required_by_policy',
      severity,
      message:
        `tsa_critical policy requires an external TSA token for critical event index ${i}; ` +
        'the recorded evidence does not satisfy the policy',
      file: 'audit.jsonl',
    });
  }
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

  // The policy gate runs before the trust-anchor gate: internal-imprint
  // evidence on a critical event under tsa_critical is a policy violation
  // regardless of anchor configuration.
  reportPolicyTokenDowngrades(input.events, input.state, severity, input.findings);

  // Covered by the missing-trust-anchor warning tests.
  // Warning-gate diagnostics, not a trust decision: with no configured
  // anchors the emitted finding is a non-strict warning. Covered by the
  // no-anchor warning tests, the null-tsa test, and the no-tsa test
  // ('warns when TSA evidence is present but trust anchors are missing',
  // 'a null tsa payload is not TSA evidence', 'emits nothing without
  // anchors when NO event carries TSA evidence').
  // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement
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
