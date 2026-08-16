/**
 * @module integration/proofgraph/surface-digest
 * @description Canonical digest over an explicit structural input surface.
 *
 * A `surface_set` provider binding is only meaningful if its digest is
 * reproducible and actually derived from the data the assertion covers.
 *
 * The digest is taken over the CANONICAL SERIALIZATION OF THE REGISTRY DATA
 * itself, not over source files on disk. This is deliberate:
 *
 * - it is identical in a source checkout and in an installed package, where the
 *   TypeScript sources do not exist;
 * - it changes exactly when the covered registry/schema content changes, which
 *   is precisely the staleness signal the evaluator needs;
 * - it needs no filesystem access, so structural evidence stays deterministic.
 *
 * `locations` on the resulting binding remain descriptive: they name the modules
 * that constitute the surface, so a reviewer can find them.
 *
 * @version v1
 */

import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';

/**
 * Compute the canonical digest of a structural input surface.
 *
 * @param surfaceData Serializable snapshot of the covered registry/schema data.
 * @returns SHA-256 hex digest over the canonical JSON of `surfaceData`.
 */
export function computeSurfaceDigest(surfaceData: unknown): string {
  return hashText(canonicalJsonStringify(surfaceData));
}
