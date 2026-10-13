/**
 * @module audit/iso27001/selector-resolve
 * @description Pure resolution of the closed selector vocabulary against a
 * verified archive snapshot. Resolution logic is separated from the vocabulary
 * schemas (`selectors.ts`) so both stay within the file-size budget.
 *
 * Reused canonical authorities (no parallel security logic):
 * - `hasCurrentPlanApprovalCertificateForState` — current plan certificate binding
 * - `authorizedCriticalPlanClaimIds` — cert-authorized critical-claim coverage
 * - `classifyValidationDisposition` — supported / artifact_failure / technical_block
 * - `decisionReceipts` (audit/query, supplied via context) — only receipt derivation
 * - `verifyChain` / `getLastChainHash` — audit chain authority
 *
 * @version v1
 */

import { isAssuranceAtLeast } from '../../shared/actor-assurance.js';
import { hashText } from '../../shared/hashing.js';
import { evaluateWithEvent } from '../../machine/evaluate.js';
import { getLastChainHash, verifyChain } from '../integrity.js';
import type { DecisionReceipt } from '../query.js';
import type { LoopVerdict } from '../../state/evidence-primitives.js';
import type { DecisionIdentity } from '../../state/evidence-identity.js';
import {
  authorizedCriticalPlanClaimIds,
  hasCurrentPlanApprovalCertificateForState,
} from '../../state/proofgraph-approval-context.js';
import type { PlanApprovalCertificate } from '../../state/proofgraph-plan-certificate.js';
import type { ReviewFindings } from '../../state/evidence-review-attestation.js';
import { Event } from '../../state/schema.js';
import type { SessionState } from '../../state/schema.js';
import {
  AUDIT_MEMBER,
  type EvidenceRef,
  type EvidenceSelector,
  type SelectorContext,
  type SelectorResolution,
} from './selectors.js';
import {
  attemptBaseRef,
  attemptDisposition,
  attemptRef,
  auditRef,
  baseRef,
  missing,
  notVerified,
  planFields,
  presentUnverified,
  stateRef,
  verified,
  type ImplementationAttempt,
} from './selector-support.js';

// ─── Selector Resolution ──────────────────────────────────────────────────────

type SelectorOf<K extends EvidenceSelector['kind']> = Extract<EvidenceSelector, { kind: K }>;

type CurrentPlanCertificate =
  | { readonly kind: 'missing' }
  | { readonly kind: 'not_current' }
  | { readonly kind: 'ok'; readonly certificate: PlanApprovalCertificate };

/** Canonical current-certificate resolution (never a local validity copy). */
function currentPlanCertificateOf(state: SessionState): CurrentPlanCertificate {
  const certificate = state.plan?.approvalCertificate;
  if (certificate === undefined) return { kind: 'missing' };
  if (!hasCurrentPlanApprovalCertificateForState(state)) return { kind: 'not_current' };
  return { kind: 'ok', certificate };
}

function resolvePlanApproved(
  selector: SelectorOf<'plan.approved'>,
  context: SelectorContext,
): SelectorResolution {
  const { snapshot } = context;
  const { state } = snapshot;
  if (state.plan === null) return missing(selector, 'PLAN_ABSENT');
  const current = currentPlanCertificateOf(state);
  if (current.kind === 'missing') return missing(selector, 'APPROVAL_CERTIFICATE_MISSING');
  if (current.kind === 'not_current') {
    return notVerified(selector, 'APPROVAL_CERTIFICATE_NOT_CURRENT');
  }
  const attestation = current.certificate.approvalAttestation;
  let ref = planFields(snapshot, stateRef(snapshot));
  if (attestation.kind === 'explicit_decision') {
    const identity = attestation.decision.decisionIdentity;
    ref = {
      ...ref,
      actorIdDigest: hashText(identity.actorId),
      actorSource: identity.actorSource,
      actorAssurance: identity.actorAssurance,
      occurredAt: attestation.decision.decidedAt,
    };
  }
  return verified(selector, [ref]);
}

function resolvePlanApproverIdentity(
  selector: SelectorOf<'plan.approver_identity'>,
  context: SelectorContext,
): SelectorResolution {
  const { snapshot } = context;
  const { state } = snapshot;
  if (state.plan === null) return missing(selector, 'PLAN_ABSENT');
  const current = currentPlanCertificateOf(state);
  if (current.kind === 'missing') return missing(selector, 'APPROVAL_CERTIFICATE_MISSING');
  if (current.kind === 'not_current') {
    return notVerified(selector, 'APPROVAL_CERTIFICATE_NOT_CURRENT');
  }
  const attestation = current.certificate.approvalAttestation;
  if (attestation.kind === 'policy_auto') {
    return notVerified(selector, 'APPROVER_IDENTITY_POLICY_AUTO');
  }
  const identity = attestation.decision.decisionIdentity;
  if (identity.actorSource === 'unknown') {
    return notVerified(selector, 'APPROVER_IDENTITY_UNRESOLVED');
  }
  if (!isAssuranceAtLeast(identity.actorAssurance, selector.minActorAssurance)) {
    return notVerified(
      selector,
      'APPROVER_ASSURANCE_BELOW_MINIMUM',
      `recorded=${identity.actorAssurance} required=${selector.minActorAssurance}`,
    );
  }
  const ref = planFields(snapshot, stateRef(snapshot));
  return verified(selector, [
    {
      ...ref,
      actorIdDigest: hashText(identity.actorId),
      actorSource: identity.actorSource,
      actorAssurance: identity.actorAssurance,
      occurredAt: attestation.decision.decidedAt,
    },
  ]);
}

function resolveImplementationRevision(
  selector: SelectorOf<'implementation.revision'>,
  context: SelectorContext,
): SelectorResolution {
  const { snapshot } = context;
  const implementation = snapshot.state.implementation;
  if (implementation === null) return missing(selector, 'IMPLEMENTATION_ABSENT');
  const review = snapshot.state.implReview;
  if (review === null) return notVerified(selector, 'IMPLEMENTATION_REVIEW_ABSENT');
  if (review.currDigest !== implementation.digest) {
    return notVerified(selector, 'IMPLEMENTATION_REVISION_STALE', review.currDigest);
  }
  let ref = attemptBaseRef(snapshot);
  if (implementation.diffDigest !== undefined) {
    const member = `implementation/implementation-diff.${implementation.diffDigest}.patch`;
    const memberSha = snapshot.fileDigests[member];
    if (memberSha === undefined) {
      return notVerified(selector, 'IMPLEMENTATION_DIFF_MEMBER_MISSING', member);
    }
    ref = { ...ref, member, memberSha256: memberSha };
  }
  return verified(selector, [{ ...ref, occurredAt: implementation.executedAt }]);
}

/** Map a non-supported attempt outcome onto the selector's fail-closed state. */
function attemptFailure(
  selector: EvidenceSelector,
  outcome: { readonly kind: 'failed' | 'blocked' },
  attempt: ImplementationAttempt,
  ref: EvidenceRef,
): SelectorResolution {
  if (outcome.kind === 'failed')
    return missing(selector, 'CHECK_FAILED', attempt.result.checkId, [ref]);
  return notVerified(
    selector,
    'CHECK_TECHNICAL_BLOCK',
    `outcome=${attempt.result.outcome} timedOut=${String(attempt.result.timedOut)}`,
    [ref],
  );
}

function resolveCheckSupported(
  selector: SelectorOf<'validation.check_supported'>,
  context: SelectorContext,
): SelectorResolution {
  const { snapshot } = context;
  if (snapshot.state.implementation === null) return missing(selector, 'IMPLEMENTATION_ABSENT');
  const outcome = attemptDisposition(snapshot, selector.checkId);
  if (outcome.kind === 'missing') {
    return missing(selector, 'CHECK_ATTEMPT_MISSING');
  }
  const ref = attemptRef(snapshot, outcome.attempt, {});
  if (outcome.kind === 'supported') return verified(selector, [ref]);
  return attemptFailure(selector, outcome, outcome.attempt, ref);
}

function resolveAssertionPassed(
  selector: SelectorOf<'validation.assertion_passed'>,
  context: SelectorContext,
): SelectorResolution {
  const { snapshot } = context;
  if (snapshot.state.implementation === null) return missing(selector, 'IMPLEMENTATION_ABSENT');
  const outcome = attemptDisposition(snapshot, selector.checkId);
  if (outcome.kind === 'missing') {
    return missing(selector, 'CHECK_ATTEMPT_MISSING');
  }
  const attempt = outcome.attempt;
  const ref = attemptRef(snapshot, attempt, {
    assertionProviderId: selector.assertion.providerId,
    assertionLocalId: selector.assertion.localId,
  });
  if (outcome.kind !== 'supported') return attemptFailure(selector, outcome, attempt, ref);
  return resolveAssertionEvidence(selector, attempt, ref);
}

function resolveAssertionEvidence(
  selector: SelectorOf<'validation.assertion_passed'>,
  attempt: ImplementationAttempt,
  ref: EvidenceRef,
): SelectorResolution {
  const extraction = attempt.result.assertionExtraction;
  if (extraction === undefined) {
    return notVerified(selector, 'ASSERTION_EXTRACTION_NOT_CONFIGURED', null, [ref]);
  }
  if (extraction.status === 'blocked') {
    return notVerified(selector, 'ASSERTION_EXTRACTION_BLOCKED', extraction.reasonCode, [ref]);
  }
  if (extraction.status === 'inconclusive') {
    return notVerified(selector, 'ASSERTION_EXTRACTION_INCONCLUSIVE', extraction.reasonCode, [ref]);
  }
  if (extraction.status !== 'extracted') {
    return notVerified(selector, 'ASSERTION_EXTRACTION_NOT_CONFIGURED', null, [ref]);
  }
  if (extraction.attemptId !== attempt.attemptId) {
    return notVerified(selector, 'ASSERTION_ATTEMPT_MISMATCH', extraction.attemptId, [ref]);
  }
  const found = extraction.assertions.find(
    (assertion) =>
      assertion.assertion.providerId === selector.assertion.providerId &&
      assertion.assertion.localId === selector.assertion.localId,
  );
  if (found === undefined) {
    return missing(
      selector,
      'ASSERTION_NOT_REPORTED',
      `${selector.assertion.providerId}:${selector.assertion.localId}`,
      [ref],
    );
  }
  if (found.status === 'passed') return verified(selector, [ref]);
  if (found.status === 'skipped') {
    return missing(selector, 'ASSERTION_SKIPPED', `${selector.assertion.localId}=skipped`, [ref]);
  }
  return missing(selector, 'ASSERTION_FAILED', `${selector.assertion.localId}=${found.status}`, [
    ref,
  ]);
}

/** Accepted independent findings bound to the current implementation digest. */
function boundAcceptedFindings(
  state: SessionState,
  acceptedVerdicts: readonly LoopVerdict[],
): { readonly obligationBound: ReviewFindings[]; readonly accepted: ReviewFindings[] } {
  const accepted = state.implReviewFindings.filter((findings) =>
    acceptedVerdicts.includes(findings.overallVerdict),
  );
  const implementation = state.implementation;
  if (implementation === null) return { obligationBound: [], accepted };
  const attempts = state.reviewAssurance?.attempts ?? [];
  const obligationBound = accepted.filter((findings) => {
    const obligationId = findings.attestation?.toolObligationId;
    if (obligationId === undefined) return false;
    return attempts.some(
      (attempt) =>
        attempt.obligationId === obligationId &&
        attempt.obligationType === 'implement' &&
        attempt.subjectDigest === implementation.digest,
    );
  });
  return { obligationBound, accepted };
}

function resolveImplementationVerdict(
  selector: SelectorOf<'review.implementation_verdict'>,
  context: SelectorContext,
): SelectorResolution {
  const { snapshot } = context;
  const { state } = snapshot;
  const implementation = state.implementation;
  if (implementation === null) return missing(selector, 'IMPLEMENTATION_ABSENT');
  const review = state.implReview;
  if (review === null) {
    return state.reducedCeremony !== null
      ? notVerified(selector, 'IMPLEMENTATION_REVIEW_WAIVED_BY_POLICY')
      : missing(selector, 'IMPLEMENTATION_REVIEW_ABSENT');
  }
  if (review.currDigest !== implementation.digest) {
    return notVerified(selector, 'IMPLEMENTATION_REVISION_STALE', review.currDigest);
  }
  if (!selector.acceptedVerdicts.includes(review.verdict)) {
    return missing(selector, 'IMPLEMENTATION_REVIEW_NOT_ACCEPTED', review.verdict);
  }
  const { obligationBound, accepted } = boundAcceptedFindings(state, selector.acceptedVerdicts);
  if (accepted.length === 0) {
    return presentUnverified(
      selector,
      'IMPLEMENTATION_REVIEW_FINDINGS_MISSING',
      'implementation review verdict recorded without accepted independent findings',
    );
  }
  if (obligationBound.length === 0) {
    return presentUnverified(
      selector,
      'IMPLEMENTATION_REVIEW_BINDING_UNVERIFIED',
      'no accepted findings entry is bound to the current implementation revision',
    );
  }
  const latest = [...obligationBound].sort((a, b) => (a.reviewedAt < b.reviewedAt ? 1 : -1))[0];
  const ref = attemptBaseRef(snapshot);
  return verified(selector, [{ ...ref, occurredAt: latest?.reviewedAt ?? null }]);
}

/**
 * Full structured decision-identity equality. Every persisted field must agree;
 * a partial match on actor id/source alone is not the recorded decision.
 */
function decisionIdentitiesEqual(a: DecisionIdentity, b: DecisionIdentity): boolean {
  return (
    a.actorId === b.actorId &&
    a.actorEmail === b.actorEmail &&
    (a.actorDisplayName ?? null) === (b.actorDisplayName ?? null) &&
    a.actorSource === b.actorSource &&
    a.actorAssurance === b.actorAssurance
  );
}

/**
 * Whether the receipt's gate transition is the canonical transition for the
 * requested gate: the receipt must leave exactly that gate, name a valid
 * machine event, and that event must resolve (canonical topology) to the
 * receipt's recorded target phase.
 */
function receiptTransitionBindsGate(
  selector: SelectorOf<'review.human_approval_decision'>,
  receipt: DecisionReceipt,
): boolean {
  if (receipt.fromPhase !== selector.gatePhase) return false;
  const event = Event.safeParse(receipt.transitionEvent);
  if (!event.success) return false;
  return evaluateWithEvent(selector.gatePhase, event.data) === receipt.toPhase;
}

/**
 * Receipts that bind the recorded decision COMPLETELY: gate, verdict, exact
 * decision time, session, full structured identity, rationale, and the
 * canonical gate transition. A receipt that merely looks similar is not a
 * confirmation of this decision.
 */
function matchingDecisionReceipts(
  context: SelectorContext,
  selector: SelectorOf<'review.human_approval_decision'>,
  state: SessionState,
): DecisionReceipt[] {
  const decision = state.reviewDecision;
  if (decision === null) return [];
  return context.receipts.filter(
    (receipt) =>
      receipt.gatePhase === selector.gatePhase &&
      receipt.verdict === decision.verdict &&
      receipt.decidedAt === decision.decidedAt &&
      receipt.flowguardSessionId === state.flowguardSessionId &&
      receipt.rationale === decision.rationale &&
      decisionIdentitiesEqual(receipt.decisionIdentity, decision.decisionIdentity) &&
      receiptTransitionBindsGate(selector, receipt),
  );
}

function resolveHumanApprovalDecision(
  selector: SelectorOf<'review.human_approval_decision'>,
  context: SelectorContext,
): SelectorResolution {
  const { snapshot } = context;
  const decision = snapshot.state.reviewDecision;
  if (decision === null) return missing(selector, 'REVIEW_DECISION_MISSING');
  if (!selector.acceptedVerdicts.includes(decision.verdict)) {
    return missing(selector, 'REVIEW_DECISION_NOT_ACCEPTED', decision.verdict);
  }
  if (!context.receiptsReadable) {
    return notVerified(selector, 'DECISION_RECEIPT_UNREADABLE');
  }
  const gateReceipts = context.receipts.filter(
    (receipt) => receipt.gatePhase === selector.gatePhase,
  );
  const matches = matchingDecisionReceipts(context, selector, snapshot.state);
  if (matches.length > 1) return notVerified(selector, 'DECISION_RECEIPT_AMBIGUOUS');
  if (matches.length === 0) {
    // No receipt at this gate at all is missing evidence; receipts that exist
    // but contradict the recorded decision are an unverifiable binding.
    return gateReceipts.length === 0
      ? missing(selector, 'DECISION_RECEIPT_MISSING')
      : notVerified(selector, 'DECISION_RECEIPT_MISMATCH');
  }
  const receipt = matches[0];
  if (receipt === undefined) return missing(selector, 'DECISION_RECEIPT_MISSING');
  if (decision.decisionIdentity.actorSource === 'unknown') {
    return notVerified(selector, 'APPROVAL_ACTOR_UNRESOLVED');
  }
  if (!isAssuranceAtLeast(decision.decisionIdentity.actorAssurance, selector.minActorAssurance)) {
    return notVerified(
      selector,
      'APPROVAL_ASSURANCE_BELOW_MINIMUM',
      `recorded=${decision.decisionIdentity.actorAssurance} required=${selector.minActorAssurance}`,
    );
  }
  const ref = auditRef(snapshot);
  return verified(selector, [
    {
      ...ref,
      actorIdDigest: hashText(decision.decisionIdentity.actorId),
      actorSource: decision.decisionIdentity.actorSource,
      actorAssurance: decision.decisionIdentity.actorAssurance,
      decisionId: receipt.decisionId,
      occurredAt: receipt.decidedAt,
    },
  ]);
}

function resolveRiskTriggersCovered(
  selector: SelectorOf<'risk.triggers_covered'>,
  context: SelectorContext,
): SelectorResolution {
  const { snapshot } = context;
  const { state } = snapshot;
  const implementation = state.implementation;
  if (implementation === null) return missing(selector, 'IMPLEMENTATION_ABSENT');
  const assessment = state.implementationRiskAssessment;
  if (assessment === null || assessment.implementationDigest !== implementation.digest) {
    return notVerified(selector, 'RISK_ASSESSMENT_NOT_BOUND');
  }
  const authorization = authorizedCriticalPlanClaimIds(state);
  if (authorization.kind === 'certificate_missing') {
    return notVerified(selector, 'APPROVAL_CERTIFICATE_MISSING');
  }
  if (authorization.kind === 'certificate_invalid') {
    return notVerified(selector, 'APPROVAL_CERTIFICATE_NOT_CURRENT');
  }
  const covered = new Set<string>();
  for (const triggers of authorization.coverage.values()) {
    for (const trigger of triggers) covered.add(trigger);
  }
  const uncovered = selector.triggers.filter((trigger) => !covered.has(trigger));
  const ref = attemptBaseRef(snapshot);
  if (uncovered.length > 0) {
    return missing(selector, 'RISK_TRIGGER_UNCOVERED', uncovered.join(','), [ref]);
  }
  return verified(selector, [ref]);
}

function resolvePolicySnapshot(
  selector: SelectorOf<'policy.snapshot'>,
  context: SelectorContext,
): SelectorResolution {
  const { snapshot } = context;
  const policy = snapshot.state.policySnapshot;
  if (selector.expectedMode !== undefined && policy.mode !== selector.expectedMode) {
    return missing(
      selector,
      'POLICY_MODE_MISMATCH',
      `recorded=${policy.mode} expected=${selector.expectedMode}`,
    );
  }
  const ref = stateRef(snapshot);
  return verified(selector, [
    {
      ...ref,
      policyHash: policy.hash,
      policyHashVersion: policy.hashVersion,
      occurredAt: policy.resolvedAt,
    },
  ]);
}

function resolveAuditChainAnchor(
  selector: SelectorOf<'audit.chain_anchor'>,
  context: SelectorContext,
): SelectorResolution {
  const { snapshot } = context;
  const events = [...snapshot.events];
  const chain = verifyChain(events);
  if (!chain.valid) {
    return notVerified(selector, 'AUDIT_ANCHOR_MISMATCH', String(chain.reason));
  }
  const head = getLastChainHash(events);
  if (head !== snapshot.auditChainHead || events.length !== snapshot.auditEventCount) {
    return notVerified(selector, 'AUDIT_ANCHOR_MISMATCH', 'manifest anchor mismatch');
  }
  return verified(selector, [auditRef(snapshot)]);
}

function resolveExportCompletion(
  selector: SelectorOf<'export.completion'>,
  context: SelectorContext,
): SelectorResolution {
  const { snapshot, liveBinding } = context;
  if (!liveBinding.stateAvailable) return notVerified(selector, 'LIVE_STATE_UNAVAILABLE');
  if (liveBinding.exportCompletionPackageDigest === null || !liveBinding.exportMaterializedEvent) {
    return missing(selector, 'EXPORT_COMPLETION_EVIDENCE_MISSING');
  }
  if (liveBinding.exportCompletionPackageDigest !== snapshot.packageSha256) {
    return notVerified(
      selector,
      'EXPORT_PACKAGE_DIGEST_MISMATCH',
      liveBinding.exportCompletionPackageDigest,
    );
  }
  const ref = baseRef(snapshot);
  const liveRef: EvidenceRef = { ...ref, source: 'live_state' };
  const liveAuditRef: EvidenceRef = {
    ...ref,
    source: 'live_audit',
    member: AUDIT_MEMBER,
    memberSha256: null,
  };
  return verified(selector, [liveRef, liveAuditRef]);
}

/** Resolve one selector against the verified snapshot. Pure and deterministic. */
export function resolveSelector(
  selector: EvidenceSelector,
  context: SelectorContext,
): SelectorResolution {
  switch (selector.kind) {
    case 'plan.approved':
      return resolvePlanApproved(selector, context);
    case 'plan.approver_identity':
      return resolvePlanApproverIdentity(selector, context);
    case 'implementation.revision':
      return resolveImplementationRevision(selector, context);
    case 'validation.check_supported':
      return resolveCheckSupported(selector, context);
    case 'validation.assertion_passed':
      return resolveAssertionPassed(selector, context);
    case 'review.implementation_verdict':
      return resolveImplementationVerdict(selector, context);
    case 'review.human_approval_decision':
      return resolveHumanApprovalDecision(selector, context);
    case 'risk.triggers_covered':
      return resolveRiskTriggersCovered(selector, context);
    case 'policy.snapshot':
      return resolvePolicySnapshot(selector, context);
    case 'audit.chain_anchor':
      return resolveAuditChainAnchor(selector, context);
    case 'export.completion':
      return resolveExportCompletion(selector, context);
  }
}
