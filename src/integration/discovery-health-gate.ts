/**
 * @module integration/discovery-health-gate
 * @description Pure decision authority for policy-gated Discovery health enforcement (#399).
 *
 * Two authorities, no duplication:
 * - `isDiscoveryHealthAllowed`: ESCALATE-ONLY. Evaluated at the mutating-tool seam.
 *   It may keep or raise a block but NEVER clears an existing block. It reads the
 *   cached drift verdict from the persisted gate rather than re-running drift.
 * - `reconcileDiscoveryHealthGate`: the SOLE clear authority. Evaluated only at
 *   /hydrate with fresh Discovery health and a fresh, bounded drift assessment.
 *
 * This module is pure: it never reads/writes artifacts and never fabricates
 * Discovery evidence. DiscoveryResult remains SSOT; policy only governs whether a
 * workflow may proceed with degraded/unavailable/drifted evidence.
 */

import type { DiscoveryHealthPolicy } from '../config/policy-types.js';
import type { DiscoveryHealthProjection } from '../discovery/discovery-health.js';
import type {
  DiscoveryDriftAssessment,
  DiscoveryHealthGate,
  DiscoveryHealthGateCode,
} from '../state/schema.js';

export interface DiscoveryHealthDecision {
  readonly allowed: boolean;
  readonly code?: DiscoveryHealthGateCode;
  readonly message?: string;
  /** Human/audit detail for the {reason} or {driftStatus} template variable. */
  readonly detail?: string;
  /** Cached drift verdict considered by this decision, if any. */
  readonly driftStatus?: DiscoveryDriftAssessment;
}

export interface IsDiscoveryHealthAllowedInput {
  readonly policy: DiscoveryHealthPolicy;
  readonly health: DiscoveryHealthProjection;
  /** Cached drift verdict persisted on the gate; undefined ⇒ treated as not_checked. */
  readonly cachedDrift?: DiscoveryDriftAssessment;
  readonly existingGate?: DiscoveryHealthGate;
}

export interface ReconcileDiscoveryHealthGateInput {
  readonly policy: DiscoveryHealthPolicy;
  readonly health: DiscoveryHealthProjection;
  /** Fresh, bounded drift verdict computed at /hydrate. */
  readonly driftAssessment: DiscoveryDriftAssessment;
  readonly now: string;
}

const ALLOWED: DiscoveryHealthDecision = { allowed: true };

/** Describe an available-but-degraded projection for audit/error templates. */
function degradedDetail(health: DiscoveryHealthProjection): string {
  if (health.status !== 'available') return health.reason;
  const parts: string[] = [];
  if (health.failedCollectors > 0) {
    parts.push(
      `failed collectors: ${health.failedCollectorNames.join(', ') || health.failedCollectors}`,
    );
  }
  if (health.partialCollectors > 0) parts.push(`partial collectors: ${health.partialCollectors}`);
  if (health.hasBudgetExhaustion) parts.push('budget exhausted');
  if (health.readFailureCount > 0) parts.push(`read failures: ${health.readFailureCount}`);
  if (health.ageWarning) parts.push('stale discovery');
  return parts.join('; ') || 'degraded discovery';
}

/**
 * Escalate-only seam decision. Never clears a block.
 *
 * Fail-closed precedence: an already-blocked gate stays blocked; otherwise
 * unavailable > degraded(block) > drift(block). off/advisory never block.
 */
export function isDiscoveryHealthAllowed(
  input: IsDiscoveryHealthAllowedInput,
): DiscoveryHealthDecision {
  const { policy, health, existingGate } = input;

  // Sticky: a persisted block continues to block until /hydrate reconciles it.
  if (existingGate?.status === 'blocked') {
    return {
      allowed: false,
      code: existingGate.code,
      message: existingGate.message,
      driftStatus: existingGate.lastDriftAssessment,
    };
  }

  if (policy.enforcement !== 'required') return ALLOWED;

  if (health.status === 'unavailable') {
    return {
      allowed: false,
      code: 'DISCOVERY_HEALTH_UNAVAILABLE',
      detail: health.reason,
      message: `Discovery evidence is unavailable (${health.reason}) and policy requires healthy Discovery.`,
    };
  }

  if (!health.healthy && policy.onDegraded === 'block') {
    const detail = degradedDetail(health);
    return {
      allowed: false,
      code: 'DISCOVERY_HEALTH_DEGRADED',
      detail,
      message: `Discovery is available but degraded (${detail}); policy onDegraded=block.`,
    };
  }

  const drift = input.cachedDrift ?? 'not_checked';
  if (drift !== 'clean' && policy.onDrift === 'block') {
    return {
      allowed: false,
      code: 'DISCOVERY_DRIFT_BLOCKED',
      detail: drift,
      driftStatus: drift,
      message: `Discovery drift verdict is ${drift}; policy onDrift=block.`,
    };
  }

  return ALLOWED;
}

/**
 * Sole clear authority. Computes the next gate from fresh evidence at /hydrate.
 *
 * Returns a `clear` gate (carrying the fresh drift verdict as cached evidence)
 * when policy is satisfied, otherwise a `blocked` gate. Never returns undefined:
 * the gate is always materialized so the seam reads a deterministic value.
 */
export function reconcileDiscoveryHealthGate(
  input: ReconcileDiscoveryHealthGateInput,
): DiscoveryHealthGate {
  const { policy, health, driftAssessment, now } = input;

  const clear: DiscoveryHealthGate = {
    status: 'clear',
    clearedAt: now,
    lastDriftAssessment: driftAssessment,
  };

  if (policy.enforcement !== 'required') return clear;

  if (health.status === 'unavailable') {
    return {
      status: 'blocked',
      code: 'DISCOVERY_HEALTH_UNAVAILABLE',
      message: `Discovery evidence is unavailable (${health.reason}) and policy requires healthy Discovery.`,
      blockedAt: now,
      lastDriftAssessment: driftAssessment,
    };
  }

  if (!health.healthy && policy.onDegraded === 'block') {
    const detail = degradedDetail(health);
    return {
      status: 'blocked',
      code: 'DISCOVERY_HEALTH_DEGRADED',
      message: `Discovery is available but degraded (${detail}); policy onDegraded=block.`,
      blockedAt: now,
      lastDriftAssessment: driftAssessment,
    };
  }

  if (driftAssessment !== 'clean' && policy.onDrift === 'block') {
    return {
      status: 'blocked',
      code: 'DISCOVERY_DRIFT_BLOCKED',
      message: `Discovery drift verdict is ${driftAssessment}; policy onDrift=block.`,
      blockedAt: now,
      lastDriftAssessment: driftAssessment,
    };
  }

  return clear;
}
