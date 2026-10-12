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
): boolean {
  return (
    detail.kind === 'decision' &&
    detail.decidedAt === decision.decidedAt &&
    detail.verdict === decision.verdict &&
    detail.rationale === decision.rationale &&
    canonicalJsonStringify(detail.decisionIdentity) === expectedIdentity
  );
}

function isEvidenceGateReceipt(detail: Record<string, unknown>): boolean {
  return (
    detail.gatePhase === 'EVIDENCE_REVIEW' &&
    detail.toPhase === 'EXPORT_READY' &&
    detail.transitionEvent === 'APPROVE'
  );
}

function decisionReceiptGate(
  previous: SessionState,
  next: SessionState,
  decision: NonNullable<SessionState['reviewDecision']>,
): 'evidence_gate' | 'other_gate' | 'ambiguous' | 'none' {
  let evidenceMatches = 0;
  let otherGate = false;
  const expectedIdentity = canonicalJsonStringify(decision.decisionIdentity);
  const operations = [...previous.pendingAuditOperations, ...next.pendingAuditOperations];
  for (const operation of operations) {
    if (operation.kind !== 'semantic') continue;
    const detail = operation.semantic.detail;
    if (!decisionReceiptMatches(detail, decision, expectedIdentity)) continue;
    if (isEvidenceGateReceipt(detail)) {
      evidenceMatches += 1;
    } else {
      otherGate = true;
    }
  }
  if (evidenceMatches > 1) return 'ambiguous';
  if (evidenceMatches === 1) return 'evidence_gate';
  if (otherGate) return 'other_gate';
  return 'none';
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
  if (next.phase !== 'EXPORT_READY') return;
  if (previous?.phase === 'EXPORT_READY') {
    if (evidenceApprovalBasisDigest(previous) !== evidenceApprovalBasisDigest(next)) {
      throw new PersistenceError(
        'EXPORT_READY_APPROVAL_UNVERIFIED',
        'Refusing to change approval-relevant evidence while already in EXPORT_READY; ' +
          'only audit/metadata updates are admissible after the approval.',
      );
    }
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
  // The approval is bound to the existing decision-receipt authority. A
  // human-gated policy always needs the recorded decision; an explicit decision
  // under an automatic policy (an override) needs its receipt too. Exactly one
  // full-content evidence-gate receipt must be present: no receipt, a receipt
  // for another gate, or ambiguous duplicates are all refused.
  if (next.policySnapshot.requireHumanGates === true && next.reviewDecision === null) {
    throw new PersistenceError(
      'EXPORT_READY_APPROVAL_UNVERIFIED',
      'Refusing a human-gated EXPORT_READY approval without a recorded decision.',
    );
  }
  if (next.reviewDecision !== null) {
    const receiptGate = decisionReceiptGate(previous, next, next.reviewDecision);
    if (receiptGate !== 'evidence_gate') {
      throw new PersistenceError(
        'EXPORT_READY_APPROVAL_UNVERIFIED',
        `Refusing an EXPORT_READY approval without exactly one fresh decision receipt bound ` +
          `to the final evidence gate (${receiptGate}).`,
      );
    }
  }
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
