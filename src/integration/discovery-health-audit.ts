/**
 * @module integration/discovery-health-audit
 * @description Single audit authority for Discovery-health gate transitions (#399).
 *
 * For a HIGH-RISK fail-closed gate, both blocking AND recovery (unblock) must be
 * auditable. This module owns the `discovery_health:gate_changed` event shape so
 * the seam (block transitions) and /hydrate (reconcile/clear transitions) emit a
 * consistent, deterministic detail payload. It emits ONLY on an auditable status
 * change (see `classifyGateTransition`) to keep the trail signal-dense.
 */

import type { SessionState, DiscoveryHealthGate } from '../state/schema.js';
import { appendReviewAuditEvent } from './review/audit-events.js';
import { classifyGateTransition } from './discovery-health-gate.js';

/**
 * Emit `discovery_health:gate_changed` iff the gate status materially changed.
 *
 * No-ops (no audit event) when the transition is `none` — e.g. a re-block with an
 * identical reason, or a clear->clear reconciliation. Callers MUST pass the
 * persisted previous gate and the freshly computed next gate.
 */
export async function auditDiscoveryHealthGateTransition(
  sessDir: string,
  state: SessionState,
  previous: DiscoveryHealthGate | undefined,
  next: DiscoveryHealthGate,
): Promise<void> {
  const transition = classifyGateTransition(previous, next);
  if (transition === 'none') return;

  const ph = state.policySnapshot.discoveryHealth;
  await appendReviewAuditEvent(
    sessDir,
    state.binding.sessionId,
    state.phase,
    'discovery_health:gate_changed',
    {
      transition,
      decision: next.status === 'blocked' ? 'blocked' : 'cleared',
      reasonCode: next.status === 'blocked' ? next.code : null,
      message: next.status === 'blocked' ? next.message : null,
      driftStatus: next.lastDriftAssessment ?? null,
      previousGateStatus: previous?.status ?? 'none',
      previousReasonCode: previous?.status === 'blocked' ? previous.code : null,
      policyMode: state.policySnapshot.mode,
      enforcement: ph.enforcement,
      onDegraded: ph.onDegraded,
      onDrift: ph.onDrift,
    },
  );
}
