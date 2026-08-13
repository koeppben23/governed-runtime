/**
 * @module integration/review/observation-service
 * @description Canonical observation processing shared by the sanctioned
 *              observation tool and the parent replay.
 *
 * Both sides must build the DELIVERED response bytes deterministically so the
 * replay can prove `responseDigest` equivalence: the tool hashes the exact
 * string it returns; the replay rebuilds the same string from re-acquired
 * immutable bytes and compares.
 *
 * @version v1
 */

import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import type { ReviewRepositoryIdentity } from '../../state/evidence.js';

/** Strict UTF-8 classification of raw blob bytes. */
export function classifyRepresentation(bytes: Buffer): 'utf8_text' | 'binary' {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf8_text';
  } catch {
    return 'binary';
  }
}

/** sha256 hex of a string (no prefix). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** Canonical digest of a delivered observation response: `sha256:<hex>`. */
export function responseDigestOf(response: string): string {
  return `sha256:${sha256Hex(response)}`;
}

/** Canonical digest of a frozen repository identity: `sha256:<hex>`. */
export function repositoryIdentityDigest(identity: ReviewRepositoryIdentity): string {
  return `sha256:${sha256Hex(canonicalJsonStringify(identity))}`;
}

/**
 * Canonical digest of raw blob bytes: `sha256:<hex>`. Authority is over RAW
 * bytes — never decoded/re-encoded text.
 */
export function contentDigestOf(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * The exact response string the observation tool delivers. Deterministic field
 * order; binary content is base64-encoded so the delivered payload round-trips
 * byte-exactly.
 */
export function buildObservationToolResponse(input: {
  readonly path: string;
  readonly revision: 'base' | 'head';
  readonly representation: 'utf8_text' | 'binary';
  readonly content: string;
}): string {
  return JSON.stringify({
    path: input.path,
    revision: input.revision,
    representation: input.representation,
    content: input.content,
  });
}
