/**
 * @module integration/plugin-discovery-health
 * @description Policy-gated Discovery health enforcement seam (#399).
 *
 * Mirrors the risk-classification seam (plugin-risk.ts): a `before` guard for
 * non-bash mutating tools and an `after` guard for bash. Both consult the pure
 * decision authority `isDiscoveryHealthAllowed` (escalate-only) and persist a
 * blocked gate on the first transition to blocked.
 *
 * Audit policy: emit `discovery_health:gate_changed` ONLY on a transition to
 * blocked (not on every check, and never on allow) to keep the audit trail
 * signal-dense and deterministic.
 */

import { existsSync } from 'node:fs';

import type { SessionState, DiscoveryHealthGate } from '../state/schema.js';
import { PersistenceError, readState } from '../adapters/persistence.js';
import { strictBlockedOutput, buildEnforcementError } from './blocked-result.js';

import {
  unavailableDiscoveryHealth,
  type DiscoveryHealthProjection,
} from '../discovery/discovery-health.js';
import { loadDiscoveryHealthContext } from './discovery/discovery-health-loader.js';
import {
  isDiscoveryHealthAllowed,
  type DiscoveryHealthDecision,
} from './discovery/discovery-health-gate.js';
import { buildDiscoveryHealthGateTransitionDetail } from './discovery/discovery-health-audit.js';
import { mutateStateWithAuditOperations } from './audit-outbox.js';

export interface DiscoveryHealthEnforcementDeps {
  getSessionDir(sessionId: string): string | null;
  getWorkspaceDir(): string | null;
}

/** True only when policy requires healthy Discovery before mutating tools run. */
function enforcementRequired(state: SessionState): boolean {
  return state.policySnapshot.discoveryHealth.enforcement === 'required';
}

/**
 * Load the health projection for the seam. Fail-closed: a missing workspace dir
 * yields an `unavailable` projection rather than skipping the check.
 */
async function seamHealthProjection(
  deps: DiscoveryHealthEnforcementDeps,
): Promise<DiscoveryHealthProjection> {
  const wsDir = deps.getWorkspaceDir();
  if (!wsDir) return unavailableDiscoveryHealth('read_failed');
  const { discoveryHealth } = await loadDiscoveryHealthContext(wsDir);
  return discoveryHealth;
}

async function persistDiscoveryHealthBlock(
  sessDir: string,
  decision: DiscoveryHealthDecision,
): Promise<void> {
  const blockedAt = new Date().toISOString();
  const code = decision.code ?? 'DISCOVERY_HEALTH_UNAVAILABLE';
  const message = decision.message ?? 'Discovery health gate blocked this mutating tool.';
  const updated = await mutateStateWithAuditOperations(sessDir, (current) => {
    if (current.discoveryHealthGate?.status === 'blocked') return { next: current };
    const blockedGate: DiscoveryHealthGate = {
      status: 'blocked',
      code,
      message,
      blockedAt,
      lastDriftAssessment: decision.driftStatus ?? current.discoveryHealthGate?.lastDriftAssessment,
    };
    const next: SessionState = { ...current, discoveryHealthGate: blockedGate };
    const detail = buildDiscoveryHealthGateTransitionDetail(
      next,
      current.discoveryHealthGate,
      blockedGate,
    );
    return {
      next,
      semanticIntents: detail
        ? [
            {
              phase: next.phase,
              event: 'discovery_health:gate_changed',
              occurredAt: blockedAt,
              detail,
            },
          ]
        : [],
    };
  });
  if (updated === null) {
    throw new PersistenceError('READ_FAILED', `no persisted session state at ${sessDir}`);
  }
}

/**
 * Pre-tool Discovery health guard for non-bash mutating tools.
 * Throws a FlowGuard enforcement error when the gate blocks.
 */
export async function enforceDiscoveryHealthBefore(
  deps: DiscoveryHealthEnforcementDeps,
  sessDir: string,
  state: SessionState,
  toolName: string,
): Promise<void> {
  if (!enforcementRequired(state)) return;

  const health = await seamHealthProjection(deps);
  const decision = isDiscoveryHealthAllowed({
    policy: state.policySnapshot.discoveryHealth,
    health,
    cachedDrift: state.discoveryHealthGate?.lastDriftAssessment,
    existingGate: state.discoveryHealthGate,
  });
  if (decision.allowed) return;

  const code = decision.code ?? 'DISCOVERY_HEALTH_UNAVAILABLE';
  const reason = decision.message ?? 'Discovery health gate blocked this mutating tool.';

  // Persist + audit ONLY on the transition to blocked (idempotent thereafter).
  if (state.discoveryHealthGate?.status !== 'blocked') {
    try {
      await persistDiscoveryHealthBlock(sessDir, decision);
    } catch (err) {
      throw buildEnforcementError(
        'AUDIT_PERSISTENCE_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  throw buildEnforcementError(code, reason, {
    sessionId: state.binding.hostSessionId,
    tool: toolName,
    reason: decision.detail ?? '',
    driftStatus: decision.driftStatus ?? '',
  });
}

/**
 * Post-bash Discovery health guard. Writes a strict blocked output object onto
 * the tool result rather than throwing, mirroring the risk after-bash seam.
 */
async function blockOnHealth(
  sessDir: string,
  state: SessionState,
  decision: ReturnType<typeof isDiscoveryHealthAllowed>,
  sessionId: string,
  output: { output?: unknown },
): Promise<void> {
  const code = decision.code ?? 'DISCOVERY_HEALTH_UNAVAILABLE';
  const reason = decision.message ?? 'Discovery health gate blocked after bash mutation.';
  try {
    if (state.discoveryHealthGate?.status !== 'blocked')
      await persistDiscoveryHealthBlock(sessDir, decision);
    output.output = strictBlockedOutput(code, {
      reason,
      sessionId,
      driftStatus: decision.driftStatus ?? '',
    });
  } catch (err) {
    output.output = strictBlockedOutput('AUDIT_PERSISTENCE_FAILED', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function enforceDiscoveryHealthAfterBash(
  deps: DiscoveryHealthEnforcementDeps,
  sessionId: string,
  output: { output?: unknown },
): Promise<void> {
  const sessDir = deps.getSessionDir(sessionId);
  if (!sessDir || !existsSync(sessDir)) {
    // A bash call is governed by the Before-hook boundary, which requires a
    // resolvable FlowGuard session. Lost context after release is an invariant
    // violation, so it fails closed instead of silently skipping the gate.
    output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason:
        'Post-bash discovery-health enforcement has no resolvable FlowGuard session context for a governed mutation.',
    });
    return;
  }

  let state: SessionState | null;
  try {
    state = await readState(sessDir);
  } catch (err) {
    output.output = strictBlockedOutput('DISCOVERY_HEALTH_UNAVAILABLE', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!state) {
    output.output = strictBlockedOutput('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      reason:
        'Post-bash discovery-health enforcement found no persisted session state for an authorized mutation.',
    });
    return;
  }
  if (!enforcementRequired(state)) return;

  const health = await seamHealthProjection(deps);
  const decision = isDiscoveryHealthAllowed({
    policy: state.policySnapshot.discoveryHealth,
    health,
    cachedDrift: state.discoveryHealthGate?.lastDriftAssessment,
    existingGate: state.discoveryHealthGate,
  });
  if (!decision.allowed) await blockOnHealth(sessDir, state, decision, sessionId, output);
}
