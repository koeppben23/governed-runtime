/**
 * @module evidence-approval-application
 * @description The protected `EVIDENCE_REVIEW -> EXPORT_READY` application and
 * the generic transition applier.
 *
 * The generic applier refuses the protected edge unconditionally. The
 * sanctioned application checks the approval AUTHORITY (recorded decision or
 * permitted automatic approval) and the canonical evidence preflight, then
 * issues the ephemeral admission the persistence boundary consumes for exactly
 * the checked basis. Extracted from `rails/types.ts` to keep both modules
 * within the file-size budget.
 *
 * @version v1
 */

import type { SessionState, Phase, Event } from '../state/schema.js';
import {
  evaluateEvidenceApprovalPreflight,
  type EvidenceApprovalPreflightResult,
} from '../audit/proofgraph/evidence-approval-preflight.js';
import {
  issueEvidenceApprovalAdmission,
  type EvidenceApprovalAdmission,
} from '../audit/proofgraph/evidence-approval-admission.js';
import { requiresGovernanceOverride } from '../machine/workflow-directive.js';
import { evidenceGateDecisionOf } from '../state/evidence-gate-decision.js';
import { ProtectedTransitionError } from './protected-transition-error.js';

/** The blocked branch of the canonical evidence-approval preflight. */
export type EvidenceApprovalPreflightBlocked = Extract<
  EvidenceApprovalPreflightResult,
  { kind: 'blocked' }
>;

/**
 * Return type for autoAdvance(): a discriminated union so the overflow and
 * protected-approval denial cases cannot be silently ignored. `advanced` is
 * the normal settle; `overflow` and `blocked` are fail-closed and force the
 * caller to stop before any persistence.
 */
/** Outcome of the sanctioned protected evidence-approval application. */
export type EvidenceApprovalApplication =
  | {
      readonly kind: 'applied';
      readonly state: SessionState;
      readonly admission: EvidenceApprovalAdmission;
    }
  | { readonly kind: 'blocked'; readonly block: EvidenceApprovalPreflightBlocked };

/**
 * Apply a transition to state. Returns a new state object (no mutation).
 * Sets phase, records transition, clears error (successful transition = no error).
 *
 * The protected `EVIDENCE_REVIEW -> EXPORT_READY` approval edge is refused
 * unconditionally here: it may only be applied through
 * {@link applyEvidenceApprovalTransition}, which enforces the canonical
 * evidence prerequisite. Rejecting every request with that destination also
 * rejects a caller that lies about the source phase.
 */
export function applyTransition(
  state: SessionState,
  from: Phase,
  to: Phase,
  event: Event,
  at: string,
): SessionState {
  if (to === 'EXPORT_READY') {
    throw new ProtectedTransitionError(
      'The EVIDENCE_REVIEW -> EXPORT_READY approval must be applied through ' +
        'applyEvidenceApprovalTransition, never the generic transition applier.',
    );
  }
  return applyTransitionUnchecked(state, from, to, event, at);
}

/**
 * Apply the protected evidence-approval transition. This is the ONLY
 * sanctioned application of the approval edge: it re-runs the canonical,
 * side-effect-free preflight on the exact state being transitioned and either
 * applies the transition or returns the canonical block. It accepts no
 * caller-supplied allowance and no alternate target.
 */
export function applyEvidenceApprovalTransition(
  state: SessionState,
  at: string,
): EvidenceApprovalApplication {
  if (state.phase !== 'EVIDENCE_REVIEW') {
    throw new ProtectedTransitionError(
      `Evidence approval can only be applied at EVIDENCE_REVIEW (observed '${state.phase}').`,
    );
  }
  // Authority first: sufficient evidence never substitutes for a permitted
  // approval. A human-gated policy requires the record of an approving decision
  // in the same candidate state; an exhausted gate requires the explicit
  // governance override even under an automatic policy.
  const authorityBlock = evidenceApprovalAuthorityBlock(state);
  if (authorityBlock) return { kind: 'blocked', block: authorityBlock };
  const preflight = evaluateEvidenceApprovalPreflight(state);
  if (preflight.kind === 'blocked') return { kind: 'blocked', block: preflight };
  const applied = applyTransitionUnchecked(state, 'EVIDENCE_REVIEW', 'EXPORT_READY', 'APPROVE', at);
  return {
    kind: 'applied',
    state: applied,
    // The admission binds the APPLIED candidate: the committed transition
    // (including its time) is part of the admitted approval.
    admission: issueEvidenceApprovalAdmission(applied),
  };
}

/**
 * Whether the approval AUTHORITY permits this transition, independent of
 * evidence sufficiency. Policy controls who may approve; it never lowers the
 * evidence bar, and sufficient evidence never manufactures an authorization.
 */
function evidenceApprovalAuthorityBlock(
  state: SessionState,
): EvidenceApprovalPreflightBlocked | null {
  const overrideRequired = requiresGovernanceOverride(state);
  // Only a decision bound to the CURRENT evidence revision counts here: a
  // carried plan approval/override must neither authorize the gate nor block a
  // policy-permitted automatic approval.
  const currentDecision = evidenceGateDecisionOf(state);
  const verdict = currentDecision?.verdict;
  if (state.policySnapshot.requireHumanGates === true) {
    return humanGateDecisionBlock(overrideRequired, currentDecision);
  }
  // Automatic policy: an exhausted gate requires the explicit override; a
  // non-exhausted gate must not carry a current-gate override decision.
  if (overrideRequired) {
    return verdict === 'approve_with_governance_override'
      ? null
      : {
          kind: 'blocked',
          code: 'GOVERNANCE_OVERRIDE_REQUIRED',
          params: { intent: 'APPROVE' },
        };
  }
  if (verdict === 'approve_with_governance_override') {
    return {
      kind: 'blocked',
      code: 'GOVERNANCE_OVERRIDE_NOT_REQUIRED',
      params: { intent: 'APPROVE_WITH_GOVERNANCE_OVERRIDE' },
    };
  }
  return null;
}

/**
 * A human-gated approval requires a CURRENT-gate recorded decision: an
 * exhausted gate demands the explicit governance override, a non-exhausted
 * gate demands a plain approval. A carried historical decision is not a
 * current-gate decision and is refused as missing.
 */
function humanGateDecisionBlock(
  overrideRequired: boolean,
  decision: SessionState['reviewDecision'],
): EvidenceApprovalPreflightBlocked | null {
  if (decision === null) {
    return {
      kind: 'blocked',
      code: 'HUMAN_DECISION_REQUIRED',
      params: {
        reason: 'a human-gated evidence approval requires a recorded decision for this gate',
      },
    };
  }
  if (overrideRequired && decision.verdict !== 'approve_with_governance_override') {
    return {
      kind: 'blocked',
      code: 'GOVERNANCE_OVERRIDE_REQUIRED',
      params: { intent: 'APPROVE' },
    };
  }
  if (!overrideRequired && decision.verdict !== 'approve') {
    return {
      kind: 'blocked',
      code: 'GOVERNANCE_OVERRIDE_NOT_REQUIRED',
      params: { intent: 'APPROVE_WITH_GOVERNANCE_OVERRIDE' },
    };
  }
  return null;
}

function applyTransitionUnchecked(
  state: SessionState,
  from: Phase,
  to: Phase,
  event: Event,
  at: string,
): SessionState {
  return {
    ...state,
    phase: to,
    transition: { from, to, event, at },
    error: null,
    // System work is durable: entering a validation phase records the pending
    // operation in the SAME atomic state write as the transition, and leaving
    // it clears the marker. A crash between the human decision and the check
    // execution is therefore recoverable instead of a dead state.
    pendingSystemWork:
      to === 'VALIDATION' || to === 'IMPL_VALIDATION'
        ? { kind: 'validation', requestedAt: at, attempt: 0, retryAfter: null }
        : null,
    // Entering IMPL_REVIEW is possible only from IMPL_VALIDATION with a FULLY
    // passing fresh validation of the current record. That is the exact point
    // where the repair loop converges, so the rework marker closes here: after
    // this, repository mutations are forbidden and only the reviewed revision
    // can be presented to a fresh independent reviewer.
    ...(from === 'IMPL_VALIDATION' && to === 'IMPL_REVIEW' ? { implementationRework: null } : {}),
  };
}
