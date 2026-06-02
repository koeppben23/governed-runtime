/**
 * @module audit/timestamp-token-verification
 * @description Async cryptographic TSA token verification for audit trails.
 */

import type { AuditEvent } from '../state/evidence.js';
import type { TimestampVerifier } from './tsa-provider.js';
import { canonicalDigestToUint8Array } from './timestamp-verification.js';
import { computeCanonicalEventDigest } from './canonical-digest.js';

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
    const evidence = event.timestampEvidence as Record<string, unknown> | undefined;
    const tsa = evidence?.tsa as Record<string, unknown> | undefined;
    const tokenDerBase64 = tsa?.tokenDerBase64;
    const cachedMessageImprint = tsa?.messageImprint;

    if (typeof tokenDerBase64 !== 'string') continue;

    const canonicalDigest = computeCanonicalEventDigest(event);

    const result = await input.verifier.verifyToken({
      tokenDerBase64,
      expectedDigest: canonicalDigestToUint8Array(canonicalDigest),
      digestAlgorithm: 'sha256',
      trustAnchors: [...input.trustAnchors],
    });

    if (result.status !== 'valid') {
      findings.push({ index: i, reason: result.reason ?? 'invalid_timestamp_token' });
      continue;
    }

    if (
      typeof cachedMessageImprint === 'string' &&
      typeof result.messageImprintHex === 'string' &&
      cachedMessageImprint !== result.messageImprintHex
    ) {
      findings.push({ index: i, reason: 'cached_message_imprint_mismatch' });
    }
  }

  return { valid: findings.length === 0, findings };
}
