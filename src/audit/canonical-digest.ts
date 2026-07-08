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

import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';

// Re-exported so existing consumers (and the SSOT guard's audit allowlist) keep
// importing the canonical serializer from here, while the single definition
// lives in shared/canonical-json.ts.
export { canonicalJsonStringify };

const EXCLUDED_FIELDS = new Set([
  'chainHash',
  'timestampEvidence',
  'canonicalEventDigest',
  'prevHash',
]);

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
  const stripped: Record<string, unknown> = {};
  for (const key of Object.keys(event).sort()) {
    if (EXCLUDED_FIELDS.has(key)) continue;
    stripped[key] = event[key];
  }
  const canonical = canonicalJsonStringify(stripped);
  return hashText(canonical);
}
