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

// ═══════════════════════════════════════════════════════════════════════════════
// Gate lifecycle transitions (auditable status changes)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify a gate status change for audit purposes (#399).
 *
 * For a HIGH-RISK fail-closed gate, both blocking AND recovery (unblock) must be
 * auditable. Transitions that warrant a `discovery_health:gate_changed` event:
 * - `to_blocked`: undefined|clear -> blocked
 * - `to_clear`: blocked -> clear (recovery / reconciliation)
 * - `block_reason_changed`: blocked -> blocked with a changed code/message/drift
 * Everything else is `none` (no audit) to keep the trail signal-dense.
 */
export type GateTransitionKind = 'to_blocked' | 'to_clear' | 'block_reason_changed' | 'none';

export function classifyGateTransition(
  prev: DiscoveryHealthGate | undefined,
  next: DiscoveryHealthGate,
): GateTransitionKind {
  const prevBlocked = prev?.status === 'blocked';
  const nextBlocked = next.status === 'blocked';

  if (!prevBlocked && nextBlocked) return 'to_blocked';
  if (prevBlocked && !nextBlocked) return 'to_clear';
  if (prev?.status === 'blocked' && next.status === 'blocked') {
    const changed =
      prev.code !== next.code ||
      prev.message !== next.message ||
      prev.lastDriftAssessment !== next.lastDriftAssessment;
    return changed ? 'block_reason_changed' : 'none';
  }
  return 'none';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Read-only computed evidence gate (status surface)
// ═══════════════════════════════════════════════════════════════════════════════

export type DiscoveryEvidenceGateAction = 'pass' | 'warn' | 'block';

/**
 * Read-only projection of the CURRENT policy decision against CURRENT evidence.
 *
 * Distinct from the persisted sticky `discoveryHealthGate`: this is recomputed on
 * every `flowguard_status` from live `discoveryHealth` + `discoveryDrift` + policy
 * so operators can see the effective gate decision a mutating tool would face,
 * even before the next tool runs or the next /hydrate reconciles the sticky gate.
 * It NEVER mutates state and is never persisted.
 */
export interface DiscoveryEvidenceGateProjection {
  readonly action: DiscoveryEvidenceGateAction;
  readonly code: DiscoveryHealthGateCode | null;
  readonly reason: string | null;
  readonly recovery: string | null;
  readonly source: 'computed_from_current_status_projection';
}

const EVIDENCE_GATE_SOURCE = 'computed_from_current_status_projection' as const;

/** Map a policy action setting to the effective action under the enforcement axis. */
function effectiveAction(
  setting: DiscoveryHealthPolicy['onDegraded'],
  advisory: boolean,
): DiscoveryEvidenceGateAction {
  if (setting === 'allow') return 'pass';
  if (setting === 'warn') return 'warn';
  // `block` is downgraded to `warn` under advisory enforcement (never blocks).
  return advisory ? 'warn' : 'block';
}

interface EvidenceSignal {
  readonly action: DiscoveryEvidenceGateAction;
  readonly code: DiscoveryHealthGateCode;
  readonly reason: string;
  readonly recovery: string;
}

export function evaluateDiscoveryEvidenceGate(
  policy: DiscoveryHealthPolicy,
  health: DiscoveryHealthProjection,
  drift: DiscoveryDriftAssessment,
): DiscoveryEvidenceGateProjection {
  if (policy.enforcement === 'off') {
    return {
      action: 'pass',
      code: null,
      reason: null,
      recovery: null,
      source: EVIDENCE_GATE_SOURCE,
    };
  }
  const advisory = policy.enforcement === 'advisory';

  const signals: EvidenceSignal[] = [];

  if (health.status === 'unavailable') {
    signals.push({
      action: advisory ? 'warn' : 'block',
      code: 'DISCOVERY_HEALTH_UNAVAILABLE',
      reason: `Discovery evidence is unavailable (${health.reason}) and policy requires healthy Discovery.`,
      recovery: health.recovery,
    });
  } else if (!health.healthy && policy.onDegraded !== 'allow') {
    const detail = degradedDetail(health);
    signals.push({
      action: effectiveAction(policy.onDegraded, advisory),
      code: 'DISCOVERY_HEALTH_DEGRADED',
      reason: `Discovery is available but degraded (${detail}); policy onDegraded=${policy.onDegraded}.`,
      recovery:
        'Re-run Discovery to clear degraded collectors, then /hydrate to reconcile the gate.',
    });
  }

  if (drift !== 'clean' && policy.onDrift !== 'allow') {
    signals.push({
      action: effectiveAction(policy.onDrift, advisory),
      code: 'DISCOVERY_DRIFT_BLOCKED',
      reason: `Discovery drift verdict is ${drift}; policy onDrift=${policy.onDrift}.`,
      recovery: 'Run /hydrate to re-baseline Discovery against the current workspace.',
    });
  }

  // Highest severity wins; precedence (unavailable > degraded > drift) breaks ties
  // because signals are pushed in that order and `find` keeps the first match.
  const chosen =
    signals.find((s) => s.action === 'block') ?? signals.find((s) => s.action === 'warn');
  if (!chosen) {
    return {
      action: 'pass',
      code: null,
      reason: null,
      recovery: null,
      source: EVIDENCE_GATE_SOURCE,
    };
  }
  return {
    action: chosen.action,
    code: chosen.code,
    reason: chosen.reason,
    recovery: chosen.recovery,
    source: EVIDENCE_GATE_SOURCE,
  };
}
