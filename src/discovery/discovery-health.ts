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
import { readDiscovery } from '../adapters/persistence-discovery.js';
import { PersistenceError } from '../adapters/persistence.js';

export type DiscoveryHealthUnavailableReason =
  | 'missing'
  | 'corrupt'
  | 'schema_invalid'
  | 'read_failed';

export interface DiscoveryHealthAvailableProjection {
  readonly kind: 'derived_discovery_health';
  readonly advisory: true;
  readonly source: 'persisted_discovery_result';
  readonly status: 'available';
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

export interface DiscoveryHealthUnavailableProjection {
  readonly kind: 'derived_discovery_health';
  readonly advisory: true;
  readonly source: 'persisted_discovery_result';
  readonly status: 'unavailable';
  readonly healthy: false;
  readonly reason: DiscoveryHealthUnavailableReason;
  readonly recovery: string;
  readonly notVerified: string[];
}

export type DiscoveryHealthProjection =
  | DiscoveryHealthAvailableProjection
  | DiscoveryHealthUnavailableProjection;

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
    status: 'available',
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

export function unavailableDiscoveryHealth(
  reason: DiscoveryHealthUnavailableReason,
): DiscoveryHealthUnavailableProjection {
  return {
    kind: 'derived_discovery_health',
    advisory: true,
    source: 'persisted_discovery_result',
    status: 'unavailable',
    healthy: false,
    reason,
    recovery: recoveryForReason(reason),
    notVerified: ['Discovery health is unavailable; mark discovery-dependent claims NOT_VERIFIED.'],
  };
}

export function isDiscoveryHealthAvailable(
  health: DiscoveryHealthProjection | null,
): health is DiscoveryHealthAvailableProjection {
  return health?.status === 'available';
}

/**
 * Map a persistence error to a fail-closed unavailable reason.
 *
 * Single source of truth shared by status projection and the #399 health gate
 * so that both surfaces classify read/parse/schema failures identically.
 */
export function classifyDiscoveryHealthUnavailable(
  error: unknown,
): DiscoveryHealthUnavailableReason {
  if (error instanceof PersistenceError) {
    switch (error.code) {
      case 'PARSE_FAILED':
        return 'corrupt';
      case 'SCHEMA_VALIDATION_FAILED':
        return 'schema_invalid';
      case 'READ_FAILED':
      case 'WRITE_FAILED':
      case 'LOCK_TIMEOUT':
        return 'read_failed';
    }
  }
  return 'read_failed';
}

export interface DiscoveryHealthContext {
  readonly discovery: DiscoveryResult | null;
  readonly discoveryHealth: DiscoveryHealthProjection;
}

/**
 * Load the persisted DiscoveryResult and derive its advisory health projection.
 *
 * Fail-closed: a missing artifact or any read/parse/schema failure yields an
 * `unavailable` projection rather than a fabricated healthy one. This is the
 * canonical cheap read used by the per-tool #399 health gate and by status.
 */
export async function loadDiscoveryHealthContext(wsDir: string): Promise<DiscoveryHealthContext> {
  try {
    const result = await readDiscovery(wsDir);
    if (!result) {
      return { discovery: null, discoveryHealth: unavailableDiscoveryHealth('missing') };
    }
    return { discovery: result, discoveryHealth: extractDiscoveryHealth(result) };
  } catch (error) {
    return {
      discovery: null,
      discoveryHealth: unavailableDiscoveryHealth(classifyDiscoveryHealthUnavailable(error)),
    };
  }
}

function recoveryForReason(reason: DiscoveryHealthUnavailableReason): string {
  switch (reason) {
    case 'missing':
      return 'Run /hydrate to recreate discovery artifacts before relying on discovery-dependent claims.';
    case 'corrupt':
      return 'Repair or remove the corrupt discovery artifact, then run /hydrate.';
    case 'schema_invalid':
      return 'Run /hydrate with the current runtime to regenerate schema-valid discovery artifacts.';
    case 'read_failed':
      return 'Fix discovery artifact filesystem access, then rerun /status or /hydrate.';
  }
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
