/**
 * @module integration/review/observations/review-validation-evidence
 * @description Canonical repository evidence authorization for DIRECTLY
 *              submitted findings (manual/SDK transports).
 *
 * A cited repository evidenceLocation is admissible ONLY against an
 * authoritative Observation of the resolved reviewer attempt — citation alone
 * is a claim, not proof. Governance rejection (`REVIEW_EVIDENCE_NOT_OBSERVED`),
 * never `schema_invalid`, never output-repairable. Extracted from
 * review-validation.ts along the evidence-binding boundary to keep both
 * modules within the file-size budget.
 *
 * @version v1
 */

import type { ReviewAttempt, ReviewFindings, ReviewObligation } from '../../../state/evidence.js';
import { resolveEvidenceAuthorizingAttempt } from '../obligations/attempt-lifecycle.js';
import type { FindingWithRelation } from '../enforcement/findings-consistency.js';
import { bindRepositoryEvidenceLocations } from './observation-binding.js';

/**
 * Minimal structural context (deliberately NOT imported from
 * review-validation.ts to keep this module acyclic).
 */
interface EvidenceValidationContext {
  readonly assurance?: import('../../../state/evidence.js').ReviewAssuranceState;
  readonly expectedObligationId?: string;
  /**
   * Exact pre-bind candidate the caller authorizes for THIS check (the created,
   * unbound successor of the obligation). Supplying it grants no general
   * evidence authority to `created` attempts: the candidate is only ever the
   * binding tuple under evaluation, and the atomic bind remains the only way
   * observations become persistent evidence.
   */
  readonly candidateAttempt?: ReviewAttempt | null;
}

/** Boundary-neutral outcome of repository-evidence admissibility evaluation. */
export type RepositoryEvidenceBindingResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'REVIEW_EVIDENCE_NOT_OBSERVED';
      readonly details: Record<string, unknown>;
    };

/**
 * Canonical evidence authorization for directly submitted findings. Attempt
 * resolution mirrors the host-task lineage: only an attempt bound to the
 * actual reviewer child session can carry observations; direct/SDK
 * submissions without such binding have NO observations and fail closed.
 */
export function evaluateRepositoryEvidenceBinding(
  findings: ReviewFindings,
  obligation: ReviewObligation | null,
  ctx: EvidenceValidationContext,
): RepositoryEvidenceBindingResult {
  const relations: FindingWithRelation[] = [];
  [...findings.blockingIssues, ...findings.majorRisks].forEach((item) => {
    if (item && typeof item === 'object') relations.push(item);
  });
  const hasEvidence = relations.some((r) => (r.relation?.evidenceLocations?.length ?? 0) > 0);
  if (!hasEvidence) return { ok: true };
  if (!obligation) {
    return {
      ok: false,
      code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
      details: {
        obligationId: ctx.expectedObligationId ?? 'unresolved',
        reason: 'no review obligation resolves for these findings',
      },
    };
  }
  const childSessionId = findings.reviewedBy?.sessionId;
  if (typeof childSessionId !== 'string' || childSessionId.length === 0) {
    return {
      ok: false,
      code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
      details: {
        obligationId: obligation.obligationId,
        reason: 'findings carry no reviewer child session identity to authorize evidence against',
      },
    };
  }
  // Fail-closed evidence-authorizing attempt: ONLY a `bound` attempt of this
  // exact obligation and child session may authorize repository evidence.
  // Rejected/stale/expired/created attempts are audit-only; a reused child
  // session can never resurface an older rejected attempt's observations.
  // The explicit pre-bind candidate is the ONLY exception: an exact binding
  // tuple under evaluation before the atomic bind.
  const attempt =
    ctx.candidateAttempt !== undefined
      ? ctx.candidateAttempt
      : ctx.assurance
        ? resolveEvidenceAuthorizingAttempt(ctx.assurance, obligation.obligationId, childSessionId)
        : null;
  const binding = bindRepositoryEvidenceLocations({
    findings: relations.map((finding) => ({
      relation: {
        evidenceLocations: finding.relation.evidenceLocations.map((location) => ({
          path: location.path,
          revision: location.revision,
          ...(location.line !== undefined ? { line: location.line } : {}),
          ...(location.endLine !== undefined ? { endLine: location.endLine } : {}),
        })),
      },
    })),
    obligation,
    attempt,
    childSessionId,
  });
  if (binding.ok) return { ok: true };
  return {
    ok: false,
    code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
    details: {
      obligationId: obligation.obligationId,
      findingIndexes: binding.failingIndexes.join(', '),
      reason: binding.reasons.join('; '),
    },
  };
}
