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
 * The chainHash binds the full record including timestampEvidence.
 *
 * Backward-compatibility: verification compares the stored
 * canonicalEventDigest with the stored timestampEvidence.tsa.messageImprint
 * without recomputation. Legacy v1 events (prevHash included in the digest)
 * therefore remain verifiable because both stored values were computed
 * together at event-creation time.
 *
 * Two-digest architecture:
 *   canonicalEventDigest → TSA messageImprint (proves event content existed at trusted time)
 *   chainHash → bindet kompletten Record (protects integrity of full event)
 *
 * @version v1
 */

import * as crypto from 'node:crypto';
import type { ChainedAuditEvent } from './types.js';

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
export function computeCanonicalEventDigest(event: Omit<ChainedAuditEvent, 'chainHash'>): string {
  const stripped: Record<string, unknown> = {};
  for (const key of Object.keys(event).sort()) {
    if (EXCLUDED_FIELDS.has(key)) continue;
    stripped[key] = (event as Record<string, unknown>)[key];
  }
  const canonical = JSON.stringify(stripped);
  return crypto.createHash('sha256').update(canonical, 'utf-8').digest('hex');
}
