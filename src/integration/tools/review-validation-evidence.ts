/**
 * @module integration/tools/review-validation-evidence
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

import type { ReviewFindings, ReviewObligation } from '../../state/evidence.js';
import { formatBlocked } from './helpers.js';
import { resolveAttempt } from '../review/assurance.js';
import type { FindingWithRelation } from '../review/enforcement/findings-consistency.js';
import { bindRepositoryEvidenceLocations } from '../review/observation-binding.js';

/**
 * Minimal structural context (deliberately NOT imported from
 * review-validation.ts to keep this module acyclic).
 */
interface EvidenceValidationContext {
  readonly assurance?: import('../../state/evidence.js').ReviewAssuranceState;
  readonly expectedObligationId?: string;
}

/**
 * Canonical evidence authorization for directly submitted findings. Attempt
 * resolution mirrors the host-task lineage: only an attempt bound to the
 * actual reviewer child session can carry observations; direct/SDK
 * submissions without such binding have NO observations and fail closed.
 */
export function checkRepositoryEvidenceBinding(
  findings: ReviewFindings,
  obligation: ReviewObligation | null,
  ctx: EvidenceValidationContext,
): string | null {
  const relations: FindingWithRelation[] = [];
  [...findings.blockingIssues, ...findings.majorRisks].forEach((item) => {
    if (item && typeof item === 'object') relations.push(item);
  });
  const hasEvidence = relations.some((r) => (r.relation?.evidenceLocations?.length ?? 0) > 0);
  if (!hasEvidence) return null;
  if (!obligation) {
    return formatBlocked('REVIEW_EVIDENCE_NOT_OBSERVED', {
      obligationId: ctx.expectedObligationId ?? 'unresolved',
      reason: 'no review obligation resolves for these findings',
    });
  }
  const childSessionId = findings.reviewedBy.sessionId;
  const attempt = ctx.assurance ? resolveAttempt(ctx.assurance, childSessionId) : null;
  const binding = bindRepositoryEvidenceLocations({
    findings: relations,
    obligation,
    attempt,
    childSessionId,
  });
  if (binding.ok) return null;
  return formatBlocked('REVIEW_EVIDENCE_NOT_OBSERVED', {
    obligationId: obligation.obligationId,
    findingIndexes: binding.failingIndexes.join(', '),
    reason: binding.reasons.join('; '),
  });
}
