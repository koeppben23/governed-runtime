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
    const finding = await verifyTokenForEvent(input.events[i]!, input.verifier, input.trustAnchors);
    if (finding) findings.push({ index: i, ...finding });
  }

  return { valid: findings.length === 0, findings };
}

/**
 * Verify the TSA token of a single stamped event (AC9): the token must be
 * cryptographically valid against the full admissible digest family, and the
 * cached imprint must be present, well-formed, and byte-identical
 * (constant-time) to the token-derived imprint — a missing or malformed cache
 * is a structural anomaly, never a silent pass.
 *
 * Sentinel contract (shared with verifyTsaMessageImprint and the canonical
 * TsaEvidenceSchema): an EMPTY `tokenDerBase64` string is the internal-imprint
 * model — no external TSA token exists, and the chain-level imprint
 * comparison is the verification authority. Only a NON-EMPTY token is
 * cryptographic material for the RFC 3161 verifier; an empty string is never
 * handed to it as a broken token.
 */
async function verifyTokenForEvent(
  event: AuditEvent,
  verifier: TimestampVerifier,
  trustAnchors: readonly string[],
): Promise<Pick<TimestampTokenFinding, 'reason'> | null> {
  const evidence = (event as Record<string, unknown>).timestampEvidence as
    Record<string, unknown> | undefined;
  const tsa = evidence?.tsa as Record<string, unknown> | undefined;
  const tokenDerBase64 = tsa?.tokenDerBase64;
  const cachedMessageImprint = tsa?.messageImprint;

  if (typeof tokenDerBase64 !== 'string' || tokenDerBase64.length === 0) return null;

  const result = await verifier.verifyToken({
    tokenDerBase64,
    // The expected digests cover the full admissible algorithm family
    // (TSA2); the verifier compares against the algorithm the TOKEN
    // declares — a token never selects its own comparator.
    expectedDigests: computeCanonicalEventDigests(event),
    trustAnchors: [...trustAnchors],
  });

  if (result.status !== 'valid') {
    return {
      reason: `${result.reason ?? 'invalid_timestamp_token'}${
        result.detail ? ` (${result.detail})` : ''
      }`,
    };
  }

  return cachedImprintMismatch(cachedMessageImprint, result.messageImprintHex);
}

/**
 * AC9 cache cross-check: the cached messageImprint must be present,
 * well-formed, and byte-identical (constant-time) to the token-derived
 * imprint — a missing or malformed cache is a structural anomaly, never a
 * silent pass.
 */
function cachedImprintMismatch(
  cachedMessageImprint: unknown,
  tokenImprintHex: string | undefined,
): Pick<TimestampTokenFinding, 'reason'> | null {
  if (typeof cachedMessageImprint !== 'string') {
    return { reason: 'missing_cached_message_imprint' };
  }
  let cachedBytes: Uint8Array;
  try {
    cachedBytes = canonicalDigestToUint8Array(cachedMessageImprint);
  } catch {
    return { reason: 'malformed_cached_message_imprint' };
  }
  if (
    typeof tokenImprintHex === 'string' &&
    !constantTimeBytesEqual(cachedBytes, canonicalDigestToUint8Array(tokenImprintHex))
  ) {
    return { reason: 'cached_message_imprint_mismatch' };
  }
  return null;
}
