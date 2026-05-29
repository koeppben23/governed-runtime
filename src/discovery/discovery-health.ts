/**
 * @module discovery/discovery-health
 * @description Runtime-only advisory projection of DiscoveryResult health.
 *
 * Derives a compact health summary from a persisted DiscoveryResult
 * for surfacing in status and agent guidance. Never persisted to
 * SessionState — DiscoveryResult remains the sole SSOT.
 *
 * Invariants:
 * - Runtime-only projection, never stored on SessionState
 * - DiscoveryResult is SSOT for all discovery data
 * - Missing/unreadable discovery returns unknown/unavailable, never fake healthy
 */

import type { DiscoveryResult } from './types.js';
import type { CodeSurfaceStatus } from './types.js';

export interface DiscoveryHealthProjection {
  readonly kind: 'derived_discovery_health';
  readonly advisory: true;
  readonly source: 'persisted_discovery_result';
  readonly completeCollectors: number;
  readonly partialCollectors: number;
  readonly failedCollectors: number;
  readonly failedCollectorNames: string[];
  readonly hasBudgetExhaustion: boolean;
  readonly readFailureCount: number;
  readonly codeSurfaceStatus: CodeSurfaceStatus | null;
  readonly collectedAt: string | null;
  readonly ageWarning: string | null;
  readonly healthy: boolean;
}

/**
 * Extract a compact advisory health projection from a DiscoveryResult.
 *
 * Derived from:
 * - result.diagnostics[] → collector status counts and failed names
 * - result.codeSurfaces?.budget.budgetExhausted → hasBudgetExhaustion
 * - result.codeSurfaces?.readStatuses → readFailureCount (non-read_ok)
 * - result.codeSurfaces?.status → codeSurfaceStatus
 * - result.collectedAt → collectedAt, ageWarning (computed)
 *
 * healthy: no failed, partial, budget exhaustion, or read failures.
 *
 * @param result - The DiscoveryResult to project from.
 * @returns DiscoveryHealthProjection — never null, always has defaults for missing data.
 */
export function extractDiscoveryHealth(result: DiscoveryResult): DiscoveryHealthProjection {
  const diagnostics = result.diagnostics ?? [];

  let completeCollectors = 0;
  let partialCollectors = 0;
  let failedCollectors = 0;
  const failedCollectorNames: string[] = [];

  for (const diag of diagnostics) {
    switch (diag.status) {
      case 'complete':
        completeCollectors++;
        break;
      case 'partial':
        partialCollectors++;
        break;
      case 'failed':
        failedCollectors++;
        failedCollectorNames.push(diag.name);
        break;
    }
  }

  const codeSurfaces = result.codeSurfaces;
  const hasBudgetExhaustion = codeSurfaces?.budget?.budgetExhausted ?? false;
  const readFailureCount = codeSurfaces?.readStatuses
    ? Object.values(codeSurfaces.readStatuses).filter((s) => s !== 'read_ok').length
    : 0;
  const codeSurfaceStatus: CodeSurfaceStatus | null = codeSurfaces?.status ?? null;
  const collectedAt: string | null = result.collectedAt ?? null;

  const ageWarning = computeAgeWarning(collectedAt);

  const healthy =
    failedCollectors === 0 &&
    partialCollectors === 0 &&
    !hasBudgetExhaustion &&
    readFailureCount === 0;

  return {
    kind: 'derived_discovery_health',
    advisory: true,
    source: 'persisted_discovery_result',
    completeCollectors,
    partialCollectors,
    failedCollectors,
    failedCollectorNames,
    hasBudgetExhaustion,
    readFailureCount,
    codeSurfaceStatus,
    collectedAt,
    ageWarning,
    healthy,
  };
}

function computeAgeWarning(collectedAt: string | null): string | null {
  if (!collectedAt) return null;
  const collected = new Date(collectedAt).getTime();
  if (isNaN(collected)) return null;
  const now = Date.now();
  const hours = (now - collected) / 3_600_000;
  if (hours > 24) {
    return `Discovery data is ${Math.round(hours)}h old and may be stale. Run /hydrate to re-discover.`;
  }
  return null;
}
