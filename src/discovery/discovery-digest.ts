/**
 * @module discovery/discovery-digest
 * @description Canonical digest authority for DiscoveryResult.
 *
 * Single source of truth for discovery hashing:
 * - computeDiscoveryDigest(): full snapshot digest (includes all fields)
 * - computeStableDriftDigest(): drift digest (excludes volatile runtime metadata)
 *
 * Invariants:
 * - canonicalize() is private — not part of any public API
 * - computeDiscoveryDigest() is backward-compatible, behavior unchanged
 * - computeStableDriftDigest() strips only collectedAt and diagnostics[].durationMs
 */
import { createHash } from 'node:crypto';
import type { DiscoveryResult } from './types.js';

/**
 * Recursively produce a canonical form of a JSON-compatible value.
 *
 * - Objects: keys sorted lexicographically, values canonicalized recursively.
 * - Arrays: element order preserved (order is semantic), values canonicalized.
 * - Primitives: returned unchanged.
 *
 * Guarantees two structurally equal values produce identical JSON.stringify
 * output regardless of original key insertion order.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Compute SHA-256 digest of a DiscoveryResult.
 *
 * Uses canonical JSON (recursively sorted keys) for deterministic hashing.
 * Used as `discoveryDigest` on SessionState for snapshot integrity.
 */
export function computeDiscoveryDigest(result: DiscoveryResult): string {
  const canonical = JSON.stringify(canonicalize(result));
  return createHash('sha256').update(canonical).digest('hex');
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
  const canonical = JSON.stringify(canonicalize(stable));
  return createHash('sha256').update(canonical).digest('hex');
}
