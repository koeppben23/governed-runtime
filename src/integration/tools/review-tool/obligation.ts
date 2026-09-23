/**
 * @module integration/tools/review-tool/obligation
 * @description Review obligation lifecycle — create, resolve, validate, consume.
 *
 * @version v1
 */
import type { SessionState } from '../../../state/schema.js';
import type { ReviewFindings, ReviewObligation } from '../../../state/evidence.js';
import {
  consumeReviewObligation,
  validateStrictAttestation,
} from '../../review/obligations/assurance.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import { formatSubagentReviewNotInvoked } from './obligation-format.js';
export {
  buildRequiredReviewAttestationPayload,
  formatMissingContentAnalysis,
} from './obligation-format.js';
import { validateChallengeConsistency } from '../../review/enforcement/challenge-consistency.js';
import {
  validateReviewFindingsScope,
  type FindingWithRelation,
} from '../../review/enforcement/findings-consistency.js';
import { collectPreviouslyUsedChallengeIds } from '../../review/obligations/challenge-history.js';
import { buildReviewChallengeContract } from '../../review/obligations/challenge-contract.js';
import type { StartedReviewResult } from './types.js';

export {
  buildReviewReferenceInput,
  hasReviewContentInput,
  validateReviewContentSource,
  hasImplicitContentSignal,
} from './review-input.js';
export { ensureMissingAnalysisObligation } from './obligation-creation.js';

// ─── Branch Review Provenance ────────────────────────────────────────────────
export {
  BranchReviewSourceSchema,
  BranchReviewProvenanceSchema,
  getRequiredBranchReviewProvenance,
  type RequiredBranchReviewSource,
  type RequiredBranchReviewProvenance,
} from '../../review/evidence/review-provenance.js';

function validateSubmittedChallengeConsistency(
  state: SessionState,
  findings: ReviewFindings,
  obligation: ReviewObligation,
): string | null {
  const challengeContract = buildReviewChallengeContract(state, obligation);
  const challengeConsistency = validateChallengeConsistency({
    overallVerdict: findings.overallVerdict,
    requiredChallengeCount: obligation.requiredChallengeCount,
    requiredChallengeKind: obligation.requiredChallengeKind ?? 'implementation_challenge',
    challenges: findings.challenges,
    // Obligation-scope + evidence binding for content challenges (findings
    // B3/B5): a content challenge must carry the active obligation id and cite
    // the canonical content ref, not a fabricated digest.
    expectedObligationId: obligation.obligationId,
    ...(challengeContract?.evidenceRefs !== undefined
      ? { allowedEvidenceRefs: challengeContract.evidenceRefs }
      : {}),
    ...(findings.challengeResolutionVerdicts !== undefined
      ? { resolutionVerdicts: findings.challengeResolutionVerdicts }
      : {}),
    previouslyUsedChallengeIds: collectPreviouslyUsedChallengeIds(state),
  });
  if (challengeConsistency.ok) return null;
  return formatSubagentReviewNotInvoked(
    `${challengeConsistency.code}: ${JSON.stringify(challengeConsistency.details)}`,
    obligation.obligationId,
  );
}

function validateSubmittedFindingsScope(
  findings: ReviewFindings,
  obligation: ReviewObligation,
): string | null {
  const scopeRelations: FindingWithRelation[] = [
    ...findings.blockingIssues,
    ...findings.majorRisks,
  ];
  const scopeResult = validateReviewFindingsScope({
    findings: scopeRelations,
    reviewSubjectScope: obligation.reviewSubjectScope,
    ...(obligation.repositoryRevisionProvenance !== undefined
      ? { repositoryRevisionProvenance: obligation.repositoryRevisionProvenance }
      : {}),
  });
  if (scopeResult.ok) return null;
  const message =
    scopeResult.code === 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE'
      ? `Reviewer findings do not relate to the reviewed subject scope at indexes: ${scopeResult.details.outOfScopeFindingIndexes.join(', ')}`
      : `Review subject scope could not be verified for obligation ${obligation.obligationId}`;
  return formatSubagentReviewNotInvoked(message, obligation.obligationId);
}

export function validateSubmittedReviewFindings(
  state: SessionState,
  findings: ReviewFindings,
  obligation: ReviewObligation,
): string | null {
  if (obligation.status === 'consumed') {
    return formatSubagentReviewNotInvoked(
      'this review obligation has already been consumed. Start a fresh /review to create a new obligation.',
      obligation.obligationId,
    );
  }

  if (findings.reviewMode !== 'subagent') {
    return formatSubagentReviewNotInvoked(
      `reviewMode is not "subagent" — findings did not come from the ${REVIEWER_SUBAGENT_TYPE} subagent`,
      obligation.obligationId,
    );
  }

  // Fail-closed on the third LoopVerdict: a reviewer that declared the
  // content unreviewable MUST NOT let the standalone /review complete with a
  // passing report. This mirrors the plan/implement/architecture tool-layer
  // guard (review-validation.ts) and the SDK gate (content-review-pipeline.ts),
  // keeping all review flows symmetric and fail-closed.
  if (findings.overallVerdict === 'unable_to_review') {
    return formatSubagentReviewNotInvoked(
      'reviewer returned overallVerdict "unable_to_review" — the content was declared unreviewable; this obligation is consumed and cannot pass review',
      obligation.obligationId,
    );
  }

  const challengeBlock = validateSubmittedChallengeConsistency(state, findings, obligation);
  if (challengeBlock) return challengeBlock;

  const scopeBlock = validateSubmittedFindingsScope(findings, obligation);
  if (scopeBlock) return scopeBlock;

  const verdict = validateStrictAttestation(findings, {
    obligationId: obligation.obligationId,
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
  });
  return verdict
    ? formatSubagentReviewNotInvoked(
        `validateStrictAttestation returned ${verdict}`,
        obligation.obligationId,
      )
    : null;
}
export function consumeValidatedReviewObligation(
  result: StartedReviewResult,
  obligation: ReviewObligation | null,
  now: string,
  consumption?: {
    readonly acceptedInvocationId?: string | null | undefined;
    readonly effectiveReviewFindings?: ReviewFindings | undefined;
  },
): StartedReviewResult {
  if (!obligation) return result;
  return {
    ...result,
    state: {
      ...result.state,
      peerReviewFindings: [
        ...(result.state.peerReviewFindings ?? []),
        ...(consumption?.effectiveReviewFindings ? [consumption.effectiveReviewFindings] : []),
      ],
      reviewAssurance: consumeReviewObligation(
        ensureReviewAssurance(result.state.reviewAssurance),
        obligation,
        now,
        consumption?.acceptedInvocationId,
      ),
    },
  };
}
