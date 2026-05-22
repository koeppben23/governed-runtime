/**
 * @module audit/timestamp-token-verification
 * @description Async cryptographic TSA token verification for audit trails.
 */

import type { AuditEvent } from '../state/evidence.js';
import type { TimestampVerifier } from './tsa-provider.js';
import { canonicalDigestToUint8Array } from './timestamp-verification.js';

export interface TimestampTokenFinding {
  readonly index: number;
  readonly reason: string;
}

export interface TimestampTokenVerificationResult {
  readonly valid: boolean;
  readonly findings: readonly TimestampTokenFinding[];
}

export async function verifyTimestampTokensForEvents(input: {
  readonly events: readonly AuditEvent[];
  readonly verifier: TimestampVerifier;
  readonly trustAnchors: readonly string[];
}): Promise<TimestampTokenVerificationResult> {
  const findings: TimestampTokenFinding[] = [];

  for (let i = 0; i < input.events.length; i++) {
    const event = input.events[i]! as Record<string, unknown>;
    const canonicalDigest = event.canonicalEventDigest;
    const evidence = event.timestampEvidence as Record<string, unknown> | undefined;
    const tsa = evidence?.tsa as Record<string, unknown> | undefined;
    const tokenDerBase64 = tsa?.tokenDerBase64;

    if (typeof canonicalDigest !== 'string' || typeof tokenDerBase64 !== 'string') continue;

    const result = await input.verifier.verifyToken({
      tokenDerBase64,
      expectedDigest: canonicalDigestToUint8Array(canonicalDigest),
      digestAlgorithm: 'sha256',
      trustAnchors: [...input.trustAnchors],
    });

    if (result.status !== 'valid') {
      findings.push({ index: i, reason: result.reason ?? 'invalid_timestamp_token' });
    }
  }

  return { valid: findings.length === 0, findings };
}
