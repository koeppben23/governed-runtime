/**
 * @module audit/canonical-digest
 * @description Canonical event digest computation for TSA anchoring.
 *
 * The canonical event digest is SHA-256 of the event without:
 * - timestampEvidence (attached AFTER TSA stamping)
 * - chainHash (computed AFTER evidence attachment)
 * - canonicalEventDigest (self-referential)
 * - prevHash (chain position — not event content)
 *
 * This digest is what the TSA stamps as messageImprint.
 * prevHash is excluded so the TSA stamp remains valid even when chain
 * position is recomputed inside an atomic append transaction.
 * The chainHash binds the full record including timestampEvidence using the
 * same recursive canonical JSON authority (`shared/canonical-json.ts`).
 *
 * Verification recomputes this digest from event content. Pure synchronous
 * verification compares it to the current internal trusted-imprint
 * representation at timestampEvidence.tsa.messageImprint. Cryptographic archive
 * verification compares it to the imprint extracted from tokenDerBase64 via the
 * configured timestamp verifier. Stored canonicalEventDigest is cross-check
 * evidence only; it is never the verification authority.
 *
 * Two-digest architecture:
 *   recomputed canonicalEventDigest → TSA messageImprint (proves event content existed at trusted time)
 *   chainHash → binds the complete record (protects integrity of full event)
 *
 * @version v1
 */

import { hashDigestBytes, hashText, type Sha2Algorithm } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';

// Re-exported so existing consumers keep importing the canonical serializer
// from here, while the single definition lives in shared/canonical-json.ts.
export { canonicalJsonStringify };

const EXCLUDED_FIELDS = new Set([
  'chainHash',
  'auditSequence',
  'recordedAt',
  'timestampEvidence',
  'semanticEventDigest',
  'prevHash',
]);

/** Canonical event content shared by every digest algorithm. */
function canonicalEventContent(event: Record<string, unknown>): string {
  const stripped: Record<string, unknown> = {};
  for (const key of Object.keys(event).sort()) {
    if (EXCLUDED_FIELDS.has(key)) continue;
    stripped[key] = event[key];
  }
  return canonicalJsonStringify(stripped);
}

/**
 * Compute the canonical event digest for TSA anchoring.
 *
 * Strip timestampEvidence, chainHash, canonicalEventDigest, and prevHash from
 * the event, then SHA-256 the canonical JSON (sorted keys, no whitespace).
 *
 * @param event - Full chained audit event (including timestampEvidence if attached).
 * @returns SHA-256 hex digest.
 */
export function computeCanonicalEventDigest(event: Record<string, unknown>): string {
  return hashText(canonicalEventContent(event));
}

/** Digest algorithms admissible for RFC 3161 message imprints (TSA2). */
export type TsDigestAlgorithm = Sha2Algorithm;

/**
 * The full admissible digest family of the canonical event content, for
 * verification of RFC 3161 tokens whose message imprint may use any of the
 * allowlisted algorithms. The verifier selects the matching digest AFTER
 * reading the token's declared imprint algorithm — a token never gets to
 * choose which expected digest it is compared against.
 */
export function computeCanonicalEventDigests(
  event: Record<string, unknown>,
): Record<TsDigestAlgorithm, Uint8Array> {
  const content = canonicalEventContent(event);
  return {
    sha256: hashDigestBytes('sha256', content),
    sha384: hashDigestBytes('sha384', content),
    sha512: hashDigestBytes('sha512', content),
  };
}
