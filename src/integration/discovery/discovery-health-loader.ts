/**
 * @module integration/discovery/discovery-health-loader
 * @description Adapter-backed discovery health loader and read-error mapping.
 *
 * The pure projections live in `discovery/discovery-health.ts`; this module owns
 * the persistence read and the adapter-error classification, so discovery/
 * stays free of adapter imports.
 *
 * @version v1
 */

import { PersistenceError } from '../../adapters/persistence.js';
import { readDiscovery } from '../../adapters/persistence-discovery.js';
import {
  extractDiscoveryHealth,
  unavailableDiscoveryHealth,
  type DiscoveryHealthContext,
  type DiscoveryHealthUnavailableReason,
} from '../../discovery/discovery-health.js';

/** Map a persistence error to a fail-closed unavailable reason. */
export function classifyDiscoveryHealthUnavailable(
  error: unknown,
): DiscoveryHealthUnavailableReason {
  if (error instanceof PersistenceError) {
    switch (error.code) {
      case 'PARSE_FAILED':
        return 'corrupt';
      case 'SCHEMA_VALIDATION_FAILED':
      case 'SESSION_STATE_INCOMPATIBLE':
        return 'schema_invalid';
      case 'READ_FAILED':
      case 'WRITE_FAILED':
      case 'DIRECT_WRITE_REQUIRES_PREPARE':
      case 'OUTBOX_ORDER_CONFLICT':
      case 'LOCK_TIMEOUT':
      case 'LOCK_TIMEOUT_EXHAUSTED':
        return 'read_failed';
    }
  }
  return 'read_failed';
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
