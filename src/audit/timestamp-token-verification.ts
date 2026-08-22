/**
 * @module audit/timestamp-token-verification
 * @description Async cryptographic TSA token verification for audit trails.
 */

import type { AuditEvent } from '../state/evidence.js';
import type { TimestampVerifier } from './tsa-provider.js';
import { canonicalDigestToUint8Array } from './timestamp-verification.js';
import { computeCanonicalEventDigests } from './canonical-digest.js';
import { constantTimeBytesEqual } from './constant-time.js';

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

    const result = await input.verifier.verifyToken({
      tokenDerBase64,
      // The expected digests cover the full admissible algorithm family
      // (TSA2); the verifier compares against the algorithm the TOKEN
      // declares — a token never selects its own comparator.
      expectedDigests: computeCanonicalEventDigests(event),
      trustAnchors: [...input.trustAnchors],
    });

    if (result.status !== 'valid') {
      findings.push({
        index: i,
        reason: `${result.reason ?? 'invalid_timestamp_token'}${
          result.detail ? ` (${result.detail})` : ''
        }`,
      });
      continue;
    }

    // AC9: a TSA-stamped event MUST carry its cached imprint; a missing or
    // malformed cache is a structural anomaly, never a silent pass. The
    // comparison is constant-time over decoded bytes (TSA4).
    if (typeof cachedMessageImprint !== 'string') {
      findings.push({ index: i, reason: 'missing_cached_message_imprint' });
      continue;
    }
    let cachedBytes: Uint8Array;
    try {
      cachedBytes = canonicalDigestToUint8Array(cachedMessageImprint);
    } catch {
      findings.push({ index: i, reason: 'malformed_cached_message_imprint' });
      continue;
    }
    if (
      typeof result.messageImprintHex === 'string' &&
      !constantTimeBytesEqual(cachedBytes, canonicalDigestToUint8Array(result.messageImprintHex))
    ) {
      findings.push({ index: i, reason: 'cached_message_imprint_mismatch' });
    }
  }

  return { valid: findings.length === 0, findings };
}
