/**
 * @module audit/proofgraph/evidence-approval-preflight
 * @description The single substantive evidence-approval prerequisite.
 *
 * Every transition from `EVIDENCE_REVIEW` to `EXPORT_READY` — policy-automatic
 * approval exactly like an explicit human or override decision — must consult
 * this authority before the transition is applied or persisted. It is pure and
 * side-effect free: no I/O, no state mutation, no audit, no actor identity.
 *
 * The decision vocabulary (precedence, certificate/evaluation/risk/coverage/
 * proof interpretation) stays owned by the enforcement projection; this module
 * only maps it to the canonical registry code once, so the explicit rail and
 * the automatic path can never drift apart.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import { defaultReasonRegistry } from '../../config/reasons.js';
import { evaluateProofGraphGateFromState } from './gate.js';
import { mapEnforcementReasonToRegistryCode } from './reason-code-mapping.js';

/** The canonical evidence-approval prerequisite outcome. */
export type EvidenceApprovalPreflightResult =
  | { readonly kind: 'clear' }
  | {
      readonly kind: 'blocked';
      readonly code: string;
      /** Registry template parameters for the canonical reason text. */
      readonly params?: Readonly<Record<string, string>>;
      /** Overrides the registry reason with persisted forensic text when present. */
      readonly reason?: string;
      /** Overrides the registry recovery steps when present. */
      readonly recovery?: readonly string[];
    };

/**
 * A persisted blocking plan-claim rejection stops evidence approval: the plan
 * authority itself is defective and no later evidence can repair it. The
 * persisted reason is surfaced verbatim (historical forensic record) and its
 * recovery is supplemented with the current catalog steps.
 */
function rejectedCriticalClaimBlock(state: SessionState): EvidenceApprovalPreflightResult | null {
  const claim = state.plan?.claimSubmissionDiagnostics?.rejectedClaims.find(
    (item) => item.disposition === 'rejected_blocking',
  );
  if (!claim) return null;
  const currentRecovery =
    defaultReasonRegistry.get('PROOFGRAPH_CLAIM_NOT_DECLARED')?.recoverySteps ?? [];
  return {
    kind: 'blocked',
    code: 'PROOFGRAPH_CLAIM_NOT_DECLARED',
    reason: claim.reason,
    recovery: [...new Set([...claim.recovery, ...currentRecovery])],
  };
}

/**
 * Evaluate the substantive evidence-approval prerequisite for the current
 * session state. Outside `EVIDENCE_REVIEW` the ProofGraph gate is not an
 * approval precondition (the plan gate keeps its own rejected-claim check).
 */
export function evaluateEvidenceApprovalPreflight(
  state: SessionState,
): EvidenceApprovalPreflightResult {
  const rejected = rejectedCriticalClaimBlock(state);
  if (rejected) return rejected;
  if (state.phase !== 'EVIDENCE_REVIEW') return { kind: 'clear' };
  const decision = evaluateProofGraphGateFromState(state);
  if (!decision.gated) return { kind: 'clear' };
  if (decision.kind === 'critical_fact_required') {
    return {
      kind: 'blocked',
      code: 'PROOFGRAPH_CRITICAL_FACT_REQUIRED',
      params: { triggers: decision.relevantTriggers.join(', ') },
    };
  }
  if (decision.kind === 'risk_trigger_uncovered') {
    return {
      kind: 'blocked',
      code: 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
      params: { triggers: decision.uncoveredTriggers.join(', ') },
    };
  }
  if (decision.kind === 'facts_unproven') {
    const claimDetails = decision.blockingClaims
      .map((bc) => `${bc.claimId} (${bc.registryCode})`)
      .join(', ');
    return {
      kind: 'blocked',
      code: 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
      params: {
        claimDetails,
        claimIds: decision.blockingClaimIds.join(', '),
      },
    };
  }
  const registryCode = mapEnforcementReasonToRegistryCode(decision.reasonCode);
  if (decision.kind === 'evaluation_unavailable') {
    return {
      kind: 'blocked',
      code: registryCode,
      params: { claimIds: decision.blockingClaimIds.join(', ') },
    };
  }
  return { kind: 'blocked', code: registryCode };
}
