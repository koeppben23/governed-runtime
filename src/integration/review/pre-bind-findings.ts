/**
 * @module integration/review/pre-bind-findings
 * @description Validates frozen finding invariants before an attempt is bound.
 *
 * Candidate findings are checked against the exact created attempt inside the
 * serialized evidence mutation. This grants no general evidence authority to
 * `created` attempts: the attempt is only ever the binding tuple under
 * evaluation, and repository evidence admissibility stays owned by the
 * canonical structured-evidence validator.
 */

import type { ReviewAttempt, ReviewFindings, ReviewObligation } from '../../state/evidence.js';
import {
  validateReviewFindingsScope,
  type FindingWithRelation,
} from './enforcement/findings-consistency.js';
import { evaluateRepositoryEvidenceBinding } from '../tools/review-validation-evidence.js';

export type PreBindFindingsResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly details: Record<string, unknown> };

export function validatePreBindFindings(input: {
  readonly findings: Record<string, unknown>;
  readonly obligation: ReviewObligation;
  readonly attempt: ReviewAttempt;
  readonly childSessionId: string;
}): PreBindFindingsResult {
  const relations = collectFindingRelations(input.findings);
  const scope = validateReviewFindingsScope({
    findings: relations,
    reviewSubjectScope: input.obligation.reviewSubjectScope,
    repositoryRevisionProvenance: input.obligation.repositoryRevisionProvenance,
  });
  if (!scope.ok) {
    return {
      ok: false,
      code: scope.code,
      details: {
        obligationId: input.obligation.obligationId,
        findingIndex: scope.details.outOfScopeFindingIndexes.join(', '),
      },
    };
  }
  const evidence = evaluateRepositoryEvidenceBinding(
    input.findings as unknown as ReviewFindings,
    input.obligation,
    {
      candidateAttempt: input.attempt,
      expectedObligationId: input.obligation.obligationId,
    },
  );
  return evidence.ok ? { ok: true } : { ok: false, code: evidence.code, details: evidence.details };
}

function collectFindingRelations(findings: Record<string, unknown>): FindingWithRelation[] {
  const relations: FindingWithRelation[] = [];
  for (const key of ['blockingIssues', 'majorRisks'] as const) {
    const items = findings[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item && typeof item === 'object') relations.push(item as FindingWithRelation);
    }
  }
  return relations;
}
