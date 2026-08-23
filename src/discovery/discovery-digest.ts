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

const COLLECTOR_OUTPUTS = {
  'repo-metadata': 'repoMetadata',
  'stack-detection': 'stack',
  topology: 'topology',
  'surface-detection': 'surfaces',
  'code-surface-analysis': 'codeSurfaces',
  'domain-signals': 'domainSignals',
} as const;

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
 * Compute stable digests for every semantic producer in DiscoveryResult.
 * Together these projections cover every field in the stable global digest,
 * so a semantic global drift always has a named diagnostic contributor.
 */
export function computeStableDiscoveryContributorDigests(
  result: DiscoveryResult,
): ReadonlyMap<string, string> {
  const digests = new Map<string, string>();
  const diagnosticsByName = new Map(
    result.diagnostics?.map(({ durationMs: _durationMs, ...diagnostic }) => [
      diagnostic.name,
      diagnostic,
    ]),
  );
  const collectorNames = new Set([
    ...Object.keys(result.collectors),
    ...diagnosticsByName.keys(),
    ...Object.keys(COLLECTOR_OUTPUTS),
  ]);

  for (const name of [...collectorNames].sort()) {
    const outputKey = COLLECTOR_OUTPUTS[name as keyof typeof COLLECTOR_OUTPUTS];
    digests.set(
      name,
      hashText(
        canonicalJsonStringify({
          status: result.collectors[name] ?? null,
          diagnostic: diagnosticsByName.get(name) ?? null,
          output: outputKey ? result[outputKey] : null,
        }),
      ),
    );
  }
  digests.set('validation-hints', hashText(canonicalJsonStringify(result.validationHints)));
  digests.set(
    'discovery-metadata',
    hashText(
      canonicalJsonStringify({
        schemaVersion: result.schemaVersion,
        diagnosticOrder: result.diagnostics?.map((diagnostic) => diagnostic.name) ?? [],
      }),
    ),
  );
  return digests;
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
