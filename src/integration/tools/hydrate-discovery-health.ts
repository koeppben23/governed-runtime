/** @module integration/tools/hydrate-discovery-health — Discovery-health gate reconciliation. */

import type { RailResult } from '../../rails/types.js';
import type { DiscoveryDriftAssessment } from '../../state/schema.js';
import { loadDiscoveryHealthContext } from '../../discovery/discovery-health.js';
import { buildDiscoveryDriftStatus } from '../discovery-drift-status.js';
import { reconcileDiscoveryHealthGate } from '../discovery-health-gate.js';
import { buildDiscoveryHealthGateTransitionDetail } from '../discovery-health-audit.js';
import type { SemanticAuditIntent } from './audit-outbox.js';
export interface ReconcileGateContext {
  readonly sessDir: string;
  readonly workspaceDir: string;
  readonly worktree: string;
  readonly fingerprint: string;
  readonly now: string;
}

export interface ReconciledDiscoveryHealthGate {
  readonly result: RailResult;
  readonly semanticIntents: readonly SemanticAuditIntent[];
}

/**
 * Compute and attach the Discovery-health gate at hydrate (#399).
 *
 * This is the ONLY site that may clear a blocked gate. It reads the current
 * persisted DiscoveryResult (SSOT) for the health projection and runs a single
 * bounded drift check; both feed the pure `reconcileDiscoveryHealthGate`
 * authority. Drift IO is skipped entirely unless enforcement is 'required'.
 *
 * Gate lifecycle audit: because this is the sole clear authority, it also emits
 * the `discovery_health:gate_changed` event for both block AND clear (recovery)
 * transitions via the single audit authority, so unblocks are auditable.
 *
 * Exported for targeted lifecycle tests; not part of the public tool surface.
 */
export async function reconcileHydrateDiscoveryHealthGate(
  result: RailResult,
  ctx: ReconcileGateContext,
): Promise<ReconciledDiscoveryHealthGate> {
  if (result.kind !== 'ok') return { result, semanticIntents: [] };

  const previousGate = result.state.discoveryHealthGate;
  const policy = result.state.policySnapshot.discoveryHealth;
  const { discoveryHealth } = await loadDiscoveryHealthContext(ctx.workspaceDir);

  let driftAssessment: DiscoveryDriftAssessment = 'not_checked';
  if (policy.enforcement === 'required') {
    const drift = await buildDiscoveryDriftStatus({
      workspaceDir: ctx.workspaceDir,
      worktree: ctx.worktree,
      fingerprint: ctx.fingerprint,
    });
    driftAssessment = drift.status;
  }

  const discoveryHealthGate = reconcileDiscoveryHealthGate({
    policy,
    health: discoveryHealth,
    driftAssessment,
    now: ctx.now,
  });

  const nextState = { ...result.state, discoveryHealthGate };
  const detail = buildDiscoveryHealthGateTransitionDetail(
    nextState,
    previousGate,
    discoveryHealthGate,
  );
  return {
    result: { ...result, state: nextState },
    semanticIntents: detail
      ? [
          {
            phase: nextState.phase,
            event: 'discovery_health:gate_changed',
            occurredAt: ctx.now,
            detail,
          },
        ]
      : [],
  };
}
