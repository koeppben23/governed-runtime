/**
 * @module evidence-approval-write-guard
 * @description The lowest evidence-approval write guard.
 *
 * A newly entered `EXPORT_READY` is refused unless it is authorized for exactly
 * the written basis: the ephemeral admission from the canonical protected
 * application, the `EVIDENCE_REVIEW` predecessor, a decision receipt bound to
 * the final evidence gate (human-gated decisions and explicit overrides), and
 * no bootstrap. Approval-relevant evidence is immutable while approved;
 * audit/metadata updates stay possible. Extracted from `adapters/persistence.ts`
 * so the writer module stays within the file-size budget.
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { evidenceGateDecisionOf } from '../state/evidence-gate-decision.js';
import { PersistenceError } from './persistence-core.js';
import {
  consumeEvidenceApprovalAdmission,
  evidenceApprovalBasisDigest,
} from '../audit/proofgraph/evidence-approval-admission.js';

/**
 * Gate disposition of the decision-receipt authority for the recorded decision.
 *
 * A receipt matches only when it binds the FULL decision (verdict, rationale,
 * decidedAt, and the complete structured identity) AND the exact
 * `EVIDENCE_REVIEW -> EXPORT_READY` APPROVE transition. Exactly one such
 * receipt must exist in the committed or persisted outbox; a receipt for a
 * DIFFERENT gate, no receipt at all, or several ambiguous matches are
 * fail-closed. No timestamp fallback exists on a v11 approval.
 */
function decisionReceiptMatches(
  detail: Record<string, unknown>,
  decision: NonNullable<SessionState['reviewDecision']>,
  expectedIdentity: string,
  transitionAt: string,
): boolean {
  if (
    detail.kind !== 'decision' ||
    detail.decidedAt !== decision.decidedAt ||
    detail.verdict !== decision.verdict ||
    detail.rationale !== decision.rationale ||
    detail.transitionAt !== transitionAt ||
    canonicalJsonStringify(detail.decisionIdentity) !== expectedIdentity
  ) {
    return false;
  }
  // Chronology: a receipt may only attest an approval transition that did not
  // predate the decision it carries.
  const decidedAtMs = Date.parse(decision.decidedAt);
  const transitionAtMs = Date.parse(transitionAt);
  return (
    !Number.isNaN(decidedAtMs) && !Number.isNaN(transitionAtMs) && decidedAtMs <= transitionAtMs
  );
}

function isEvidenceGateReceipt(detail: Record<string, unknown>): boolean {
  return (
    detail.gatePhase === 'EVIDENCE_REVIEW' &&
    detail.toPhase === 'EXPORT_READY' &&
    detail.transitionEvent === 'APPROVE'
  );
}

interface ReceiptScan {
  readonly evidenceMatches: number;
  readonly otherGate: boolean;
  readonly conflict: boolean;
}

/**
 * Scan the committed and persisted outbox for receipts of the exact decision.
 * Canonical operation identity first: the same operation carried unchanged
 * from the predecessor into the successor is ONE receipt, not two. The same id
 * with DIFFERENT content is a contradictory record, never a silent overwrite.
 */
function scanDecisionReceipts(
  previous: SessionState,
  next: SessionState,
  decision: NonNullable<SessionState['reviewDecision']>,
  transitionAt: string | undefined,
): ReceiptScan {
  let evidenceMatches = 0;
  let otherGate = false;
  const expectedIdentity = canonicalJsonStringify(decision.decisionIdentity);
  const seen = new Map<string, string>();
  for (const operation of [...previous.pendingAuditOperations, ...next.pendingAuditOperations]) {
    const content = canonicalJsonStringify(operation);
    if (seen.has(operation.operationId)) {
      if (seen.get(operation.operationId) !== content)
        return { evidenceMatches, otherGate, conflict: true };
      continue;
    }
    seen.set(operation.operationId, content);
    if (transitionAt === undefined || operation.kind !== 'semantic') continue;
    const detail = operation.semantic.detail;
    if (!decisionReceiptMatches(detail, decision, expectedIdentity, transitionAt)) continue;
    if (isEvidenceGateReceipt(detail)) evidenceMatches += 1;
    else otherGate = true;
  }
  return { evidenceMatches, otherGate, conflict: false };
}

function decisionReceiptGate(
  previous: SessionState,
  next: SessionState,
  decision: NonNullable<SessionState['reviewDecision']>,
  transitionAt: string | undefined,
): 'evidence_gate' | 'other_gate' | 'ambiguous' | 'none' {
  const scan = scanDecisionReceipts(previous, next, decision, transitionAt);
  // One evidence-gate receipt plus any receipt of the same decision at another
  // gate is a contradiction, not a preference.
  if (scan.conflict || scan.evidenceMatches > 1 || (scan.evidenceMatches === 1 && scan.otherGate)) {
    return 'ambiguous';
  }
  if (scan.evidenceMatches === 1) return 'evidence_gate';
  if (scan.otherGate) return 'other_gate';
  return 'none';
}

/**
 * Every EXPORT_READY write must present exactly the canonical approval
 * transition. This is the shape half of the transition binding; the admission
 * binds the applied transition INCLUDING its time, so an issued admission can
 * never be replayed on a tampered transition record.
 */
function assertCanonicalApprovalTransition(next: SessionState): void {
  const transition = next.transition;
  if (
    transition !== null &&
    transition.from === 'EVIDENCE_REVIEW' &&
    transition.to === 'EXPORT_READY' &&
    transition.event === 'APPROVE'
  ) {
    return;
  }
  throw new PersistenceError(
    'EXPORT_READY_APPROVAL_UNVERIFIED',
    'Refusing an EXPORT_READY state without the canonical EVIDENCE_REVIEW -> EXPORT_READY ' +
      'APPROVE transition that authorized the approval.',
  );
}

/** Approval-relevant evidence is immutable while a session is already approved. */
function assertApprovalBasisImmutable(previous: SessionState, next: SessionState): void {
  if (evidenceApprovalBasisDigest(previous) === evidenceApprovalBasisDigest(next)) return;
  throw new PersistenceError(
    'EXPORT_READY_APPROVAL_UNVERIFIED',
    'Refusing to change approval-relevant evidence while already in EXPORT_READY; ' +
      'only audit/metadata updates are admissible after the approval.',
  );
}

/**
 * A human-gated approval requires a CURRENT-gate recorded decision; a
 * current-gate decision (human-gated approval or an explicit override) requires
 * exactly one fresh full-content evidence-gate receipt: no receipt, a receipt
 * for another gate, or ambiguous duplicates are refused.
 */
function assertCurrentDecisionAuthorization(
  previous: SessionState,
  next: SessionState,
  currentDecision: SessionState['reviewDecision'],
): void {
  if (next.policySnapshot.requireHumanGates === true && currentDecision === null) {
    throw new PersistenceError(
      'EXPORT_READY_APPROVAL_UNVERIFIED',
      'Refusing a human-gated EXPORT_READY approval without a current-gate recorded decision.',
    );
  }
  if (currentDecision === null) return;
  const receiptGate = decisionReceiptGate(previous, next, currentDecision, next.transition?.at);
  if (receiptGate !== 'evidence_gate') {
    throw new PersistenceError(
      'EXPORT_READY_APPROVAL_UNVERIFIED',
      `Refusing an EXPORT_READY approval without exactly one fresh decision receipt bound ` +
        `to the final evidence gate (${receiptGate}).`,
    );
  }
}

/**
 * Refuse a newly entered `EXPORT_READY` that is not authorized for exactly the
 * written basis: the ephemeral admission from the canonical protected
 * application, the `EVIDENCE_REVIEW` predecessor, a decision receipt for the
 * final gate under a human-gated policy, and no bootstrap. Approval-relevant
 * evidence is immutable while approved; audit/metadata updates stay possible.
 */
export async function assertEvidenceApprovalWriteBoundary(
  previous: SessionState | null,
  next: SessionState,
  approvalAdmission: unknown,
): Promise<void> {
  if (next.phase !== 'EXPORT_READY') {
    if (previous?.phase === 'EXPORT_READY') assertApprovalBasisImmutable(previous, next);
    return;
  }
  if (previous?.phase === 'EXPORT_READY') {
    assertApprovalBasisImmutable(previous, next);
    return;
  }
  if (previous === null) {
    throw new PersistenceError(
      'EXPORT_READY_APPROVAL_UNVERIFIED',
      'Refusing to bootstrap a session directly into EXPORT_READY: a final evidence ' +
        'approval requires an existing session with an approved evidence basis.',
    );
  }
  if (previous.phase !== 'EVIDENCE_REVIEW') {
    throw new PersistenceError(
      'EXPORT_READY_APPROVAL_UNVERIFIED',
      `Refusing an EXPORT_READY entry from phase '${previous.phase}': only an ` +
        'EVIDENCE_REVIEW approval can enter EXPORT_READY.',
    );
  }
  assertCanonicalApprovalTransition(next);
  // The approval is bound to the existing decision-receipt authority, but only
  // a decision that belongs to the CURRENT evidence revision counts: a carried
  // plan approval/override is historical evidence and neither authorizes the
  // gate nor blocks a policy-permitted automatic approval.
  assertCurrentDecisionAuthorization(previous, next, evidenceGateDecisionOf(next));
  const consumption = consumeEvidenceApprovalAdmission({
    admission: approvalAdmission,
    state: next,
    predecessor: previous,
  });
  if (consumption.kind !== 'accepted') {
    throw new PersistenceError(
      'EXPORT_READY_APPROVAL_UNVERIFIED',
      `Refusing to persist an EXPORT_READY approval without an authentic admission ` +
        `(${consumption.reason}). The approval must be applied through the protected ` +
        'transition application against a current, admitted evidence basis.',
    );
  }
}
