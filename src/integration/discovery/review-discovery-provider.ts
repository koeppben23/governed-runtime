/**
 * @module integration/discovery/review-discovery-provider
 * @description Structural provider object for review/'s Discovery context port.
 *
 * The review bounded context must not import discovery modules; command and
 * composition callers import this provider and inject it. Narrowing casts live
 * here, at the owning authority boundary.
 *
 * @version v1
 */

import {
  extractDiscoveryHealth,
  unavailableDiscoveryHealth,
  type DiscoveryHealthUnavailableReason,
} from '../../discovery/discovery-health.js';
import type { DiscoveryResult } from '../../discovery/types.js';
import {
  buildDiscoveryDriftStatus,
  notCheckedDiscoveryDriftStatus,
} from './discovery-drift-status.js';

export const REVIEW_DISCOVERY_PROVIDER = {
  build: buildDiscoveryDriftStatus,
  notChecked: notCheckedDiscoveryDriftStatus,
  extractHealth: (discovery: unknown) => extractDiscoveryHealth(discovery as DiscoveryResult),
  unavailableHealth: (reason: unknown) =>
    unavailableDiscoveryHealth(reason as DiscoveryHealthUnavailableReason),
} as const;
