/**
 * @module discovery/discovery-digest
 * @description Discovery digest computation for DiscoveryResult.
 *
 * - computeDiscoveryDigest(): full snapshot digest (includes all fields)
 * - computeStableDriftDigest(): drift digest (excludes volatile runtime metadata)
 *
 * JSON canonicalization is delegated to the single canonical serializer in
 * `shared/canonical-json.ts`; this module does NOT define its own. Invariants:
 * - computeDiscoveryDigest() is backward-compatible, behavior unchanged
 * - computeStableDriftDigest() strips only collectedAt and diagnostics[].durationMs
 */
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import type { DiscoveryResult } from './types.js';

/**
 * Compute SHA-256 digest of a DiscoveryResult.
 *
 * Uses canonical JSON (recursively sorted keys) for deterministic hashing.
 * Used as `discoveryDigest` on SessionState for snapshot integrity.
 */
export function computeDiscoveryDigest(result: DiscoveryResult): string {
  return hashText(canonicalJsonStringify(result));
}

/**
 * Produce a stable projection of DiscoveryResult for drift comparison.
 *
 * Strips volatile runtime metadata that changes between runs:
 * - collectedAt (ISO timestamp — differs every run)
 * - diagnostics[].durationMs (wall-clock timing — varies per run)
 *
 * Preserves all content-semantic fields including:
 * - schemaVersion, collectors, diagnostics[].{name, status, timedOut,
 *   errorCode, degradedReason}
 * - repoMetadata, stack, topology, surfaces, codeSurfaces, domainSignals,
 *   validationHints
 */
function stripVolatileFields(result: DiscoveryResult): Record<string, unknown> {
  const {
    collectedAt: _collectedAt,
    diagnostics,
    ...rest
  } = result as DiscoveryResult & {
    collectedAt: string;
  };

  const strippedDiagnostics = diagnostics?.map(
    ({ durationMs: _durationMs, ...diagRest }) => diagRest,
  );

  return {
    ...rest,
    ...(strippedDiagnostics ? { diagnostics: strippedDiagnostics } : {}),
  };
}

/**
 * Compute a stable SHA-256 digest of a DiscoveryResult that excludes
 * volatile runtime fields.
 *
 * Used by checkDiscoveryDrift() to detect real repository drift without
 * false positives from timestamp or timing changes.
 */
export function computeStableDriftDigest(result: DiscoveryResult): string {
  const stable = stripVolatileFields(result);
  return hashText(canonicalJsonStringify(stable));
}
