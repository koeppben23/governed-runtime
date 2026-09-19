/**
 * @module integration/status-detail-projections
 * @description Per-flag status surfaces: evidence, why-blocked, context, readiness.
 *
 * Pure projections of canonical runtime truth; no independent interpretation.
 */

import type { SessionState } from '../state/schema.js';
import type { FlowGuardPolicy } from '../config/policy.js';
import { evaluate } from '../machine/evaluate.js';
import { resolveWorkflowDirective, type WorkflowDirective } from '../machine/workflow-directive.js';
import { evaluateValidationEvidence } from '../machine/validation-evidence.js';
import { directiveLabel } from '../presentation/directive-copy.js';
import { evaluateCompleteness } from '../audit/completeness.js';
import { evaluateProofGraphGateFromState } from '../audit/proofgraph/gate.js';
import { mapEnforcementReasonToRegistryCode } from '../audit/proofgraph/reason-code-mapping.js';
import type {
  BlockedProjection,
  ContextProjection,
  EvidenceDetailProjection,
  ReadinessProjection,
} from './status-types.js';

/**
 * Build EvidenceDetailProjection from canonical completeness report.
 *
 * Uses audit/completeness.ts as the single source of truth.
 * No new evidence rules are invented here.
 */
export function buildEvidenceDetailProjection(state: SessionState): EvidenceDetailProjection {
  const report = evaluateCompleteness(state);

  return {
    phase: state.phase,
    overallComplete: report.overallComplete,
    slots: report.slots.map((s) => ({
      slot: s.slot,
      label: s.label,
      required: s.required,
      status: s.status,
      artifactKind: s.artifactKind ?? null,
      hint: s.status === 'failed' ? (s.detail ?? null) : null,
      detail: s.detail ?? null,
    })),
    summary: {
      present: report.summary.complete,
      missing: report.summary.missing,
      notYetRequired: report.summary.notYetRequired,
      failed: report.summary.failed,
    },
    fourEyes: {
      required: report.fourEyes.required,
      satisfied: report.fourEyes.satisfied,
      initiatedBy: report.fourEyes.initiatedBy,
      decisionIdentity: report.fourEyes.decisionIdentity,
      detail: report.fourEyes.detail,
    },
  };
}

function resolveBlockerReason(input: {
  readonly validationEvidenceBlocked: boolean;
  readonly validationEvidenceCode: string | null;
  readonly proofGraphGateCode: string | null;
  readonly incompleteReview: boolean;
  readonly directive: WorkflowDirective;
}): { reasonCode: string | null; reasonText: string | null } {
  if (input.validationEvidenceBlocked) {
    return {
      reasonCode: input.validationEvidenceCode,
      reasonText: directiveLabel(input.directive.code),
    };
  }
  if (input.proofGraphGateCode) return { reasonCode: input.proofGraphGateCode, reasonText: null };
  return input.incompleteReview
    ? { reasonCode: 'REVIEW_STATE_INCOMPLETE', reasonText: directiveLabel(input.directive.code) }
    : { reasonCode: null, reasonText: null };
}

function resolveHumanActionRequired(
  evalResult: ReturnType<typeof evaluate>,
  incompleteReview: boolean,
): boolean | null {
  if (evalResult.kind === 'waiting' || incompleteReview) return true;
  return evalResult.kind === 'pending' ? null : false;
}

/** Build blocked detail projection for /status --why-blocked. */
export function buildBlockedProjection(
  state: SessionState,
  policy: FlowGuardPolicy,
): BlockedProjection {
  const evalResult = evaluate(state, { requireHumanGates: policy.requireHumanGates });
  const directive = resolveWorkflowDirective(state);
  const completeness = evaluateCompleteness(state);

  const incompleteReview = directive.code === 'WORKFLOW_BLOCKED';
  const blocked = evalResult.kind === 'waiting' || incompleteReview;
  const missingEvidence = completeness.slots
    .filter((slot) => slot.required && (slot.status === 'missing' || slot.status === 'failed'))
    .map((slot) => ({
      slot: slot.slot,
      hint: slot.status === 'failed' ? (slot.detail ?? null) : null,
    }));

  // #400: surface the explicit validation-evidence reason when VALIDATION is
  // fail-closed-blocked with no active checks. This is a projection of the single
  // authority's decision — no independent interpretation.
  const validationEvidence =
    state.phase === 'VALIDATION' ? evaluateValidationEvidence(state) : null;
  const validationEvidenceBlocked =
    validationEvidence !== null && validationEvidence.blocked && validationEvidence.code !== null;
  // #695: surface the enforced ProofGraph gate reason at EVIDENCE_REVIEW so the
  // why-blocked surface projects the gate's migrated human copy.
  const proofGraphGateCode = proofGraphGateRegistryCode(state);
  const reason = resolveBlockerReason({
    validationEvidenceBlocked,
    validationEvidenceCode: validationEvidence?.code ?? null,
    proofGraphGateCode,
    incompleteReview,
    directive,
  });

  return {
    blocked,
    reasonCode: reason.reasonCode,
    reasonText: evalResult.kind === 'waiting' ? evalResult.reason : reason.reasonText,
    recoveryHint: directive.context?.recovery ?? null,
    missingEvidence,
    nextResolvableCommand: directive.commands[0] ?? null,
    humanActionRequired: resolveHumanActionRequired(evalResult, incompleteReview),
  };
}

/** Build context detail projection for /status --context. */
export function buildContextProjection(state: SessionState): ContextProjection {
  const snapshot = state.policySnapshot;
  const isRegulated = snapshot.mode === 'regulated';
  return {
    actor: state.actorInfo
      ? {
          id: state.actorInfo.id,
          source: state.actorInfo.source,
          assurance: state.actorInfo.assurance,
        }
      : null,
    archiveStatus: state.regulatedArchiveStatus ?? null,
    policyMode: snapshot.mode,
    regulated: {
      applicable: isRegulated,
      minimumActorAssuranceForApproval: isRegulated
        ? (snapshot.minimumActorAssuranceForApproval ?? 'claim_validated')
        : null,
      centralPolicyActive: snapshot.centralMinimumMode ? true : null,
      fourEyesRelevant: isRegulated ? snapshot.allowSelfApproval === false : null,
    },
  };
}

/** Build readiness projection for /status --readiness. */
export function buildReadinessProjection(
  state: SessionState,
  policy: FlowGuardPolicy,
): ReadinessProjection {
  const completeness = evaluateCompleteness(state);
  const evalResult = evaluate(state, { requireHumanGates: policy.requireHumanGates });
  const blocked = evalResult.kind === 'waiting';
  const snapshot = state.policySnapshot;
  const warnings: string[] = [];

  return {
    phase: state.phase,
    policyMode: snapshot.mode,
    archiveStatus: state.regulatedArchiveStatus ?? null,
    blocked,
    evidenceComplete: completeness.overallComplete,
    fourEyesSatisfied: completeness.fourEyes.satisfied,
    actorKnown: state.actorInfo?.source !== 'unknown',
    minimumActorAssuranceForApproval:
      snapshot.mode === 'regulated'
        ? (snapshot.minimumActorAssuranceForApproval ?? 'claim_validated')
        : null,
    warnings,
  };
}

/**
 * Registry reason code for the enforced ProofGraph gate at EVIDENCE_REVIEW,
 * or null when no gate is active. Projection of the rail's gate decision only
 * — no independent gating authority.
 */
export function proofGraphGateRegistryCode(state: SessionState): string | null {
  if (state.phase !== 'EVIDENCE_REVIEW') return null;
  const decision = evaluateProofGraphGateFromState(state);
  if (!decision.gated) return null;
  return mapEnforcementReasonToRegistryCode(decision.reasonCode);
}
