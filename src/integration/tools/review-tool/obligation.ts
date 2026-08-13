/**
 * @module integration/tools/review-tool/obligation
 * @description Review obligation lifecycle — create, resolve, validate, consume.
 *
 * @version v1
 */
export { fingerprintReviewInput } from './fingerprint.js';
import { fingerprintReviewInput } from './fingerprint.js';
import type { SessionState } from '../../../state/schema.js';
import type { ReviewFindings, ReviewObligation } from '../../../state/evidence.js';
import {
  findLatestPendingReviewObligation,
  findReviewObligationById,
  consumeReviewObligation,
  validateStrictAttestation,
  ensureReviewAssurance,
  findAcceptedInvocationForFindings,
} from '../../review/assurance.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import { formatSubagentReviewNotInvoked } from './obligation-format.js';
export {
  buildRequiredReviewAttestationPayload,
  formatBlockedWithAttestation,
  formatMissingContentAnalysis,
  formatSubagentReviewNotInvoked,
} from './obligation-format.js';
import { validateChallengeConsistency } from '../../review/enforcement/challenge-consistency.js';
import {
  validateReviewFindingsScope,
  type FindingWithRelation,
} from '../../review/enforcement/findings-consistency.js';
import { collectPreviouslyUsedChallengeIds } from '../../review/challenge-history.js';
import { buildHostTaskChallengeContract } from '../../review/host-task-policy.js';
import { formatBlocked } from '../helpers.js';
import type { ReviewToolArgs, StartedReviewResult } from './types.js';

export {
  buildReviewReferenceInput,
  hasReviewContentInput,
  validateReviewContentSource,
  hasImplicitContentSignal,
} from './review-input.js';
import { hasReviewContentInput } from './review-input.js';
export { persistReviewObligation, ensureMissingAnalysisObligation } from './obligation-creation.js';
import { createNewReviewObligation, persistReviewObligation } from './obligation-creation.js';

// ─── Branch Review Provenance ────────────────────────────────────────────────
export {
  BranchReviewSourceSchema,
  BranchReviewProvenanceSchema,
  ReviewProvenanceError,
  getRequiredBranchReviewSource,
  getRequiredBranchReviewProvenance,
  type RequiredBranchReviewSource,
  type RequiredBranchReviewProvenance,
} from '../../review/review-provenance.js';

function fingerprintVersionOf(obligation: ReviewObligation): 'v1' | 'v2' {
  return obligation.fingerprintVersion ?? 'v1';
}

export function matchesReviewObligationInput(
  obligation: ReviewObligation,
  args: ReviewToolArgs,
): boolean {
  const inputFingerprint = obligation.metadata?.inputFingerprint;
  return (
    typeof inputFingerprint === 'string' &&
    inputFingerprint === fingerprintReviewInput(args, fingerprintVersionOf(obligation))
  );
}

/** Option A continuation: re-supply the immutable source alongside identity and verdict. */
export function validateHostTaskContinuationInput(
  obligation: ReviewObligation,
  args: ReviewToolArgs,
): string | null {
  if (!hasReviewContentInput(args)) {
    return formatBlocked('REVIEW_OBLIGATION_INPUT_MISMATCH', {
      obligationId: obligation.obligationId,
      reason:
        'A host-task continuation must include the original immutable review content fields, reviewObligationId, and reviewVerdict.',
    });
  }
  if (!matchesReviewObligationInput(obligation, args)) {
    return formatBlocked('REVIEW_OBLIGATION_INPUT_MISMATCH', {
      obligationId: obligation.obligationId,
      reason: 'The supplied review input does not match the host-task review obligation.',
    });
  }
  return null;
}

// ─── Obligation lifecycle ────────────────────────────────────────────────────

function isActiveReviewObligation(
  obligation: ReviewObligation | null,
): obligation is ReviewObligation {
  return (
    obligation?.obligationType === 'review' &&
    obligation.status !== 'consumed' &&
    obligation.status !== 'blocked'
  );
}

function validateSuppliedReviewObligation(input: {
  suppliedObligationId: string | undefined;
  obligation: ReviewObligation | null;
  attestationObligationId: string | undefined;
  args: ReviewToolArgs;
}): string | null {
  const { suppliedObligationId, obligation, attestationObligationId, args } = input;
  if (!suppliedObligationId) return null;
  let code = 'REVIEW_OBLIGATION_NOT_FOUND';
  let message: string | null = null;
  if (!isActiveReviewObligation(obligation)) {
    message = 'The supplied reviewObligationId does not identify an active review obligation.';
  } else if (!matchesReviewObligationInput(obligation, args)) {
    code = 'REVIEW_OBLIGATION_INPUT_MISMATCH';
    message = 'The supplied review input does not match reviewObligationId.';
  } else if (attestationObligationId && suppliedObligationId !== attestationObligationId) {
    message = 'reviewObligationId does not match reviewFindings.attestation.toolObligationId.';
  }
  return message
    ? JSON.stringify({
        error: true,
        code,
        message,
        obligationId: suppliedObligationId,
      })
    : null;
}

export async function resolveSubmittedReviewObligation(
  sessDir: string,
  state: SessionState,
  args: ReviewToolArgs,
  now: string,
  worktree: string | undefined,
): Promise<{ obligation: ReviewObligation | null; blocked?: string }> {
  const findings = args.reviewFindings as Record<string, unknown>;
  const attToolObligationId = (findings.attestation as Record<string, unknown> | undefined)
    ?.toolObligationId as string | undefined;
  const suppliedObligationId = args.reviewObligationId;
  const obligationById = suppliedObligationId
    ? findReviewObligationById(state.reviewAssurance, suppliedObligationId)
    : attToolObligationId
      ? findReviewObligationById(state.reviewAssurance, attToolObligationId)
      : null;
  const suppliedBlock = validateSuppliedReviewObligation({
    suppliedObligationId,
    obligation: obligationById,
    attestationObligationId: attToolObligationId,
    args,
  });
  if (suppliedBlock) {
    return {
      obligation: null,
      blocked: suppliedBlock,
    };
  }
  const fingerprint = fingerprintReviewInput(args, 'v2');
  let obligation =
    obligationById ??
    findLatestPendingReviewObligation(state.reviewAssurance, 'review', fingerprint, 'v2');

  if (!obligation) {
    const created = await createNewReviewObligation({
      state,
      args,
      now,
      worktree,
      resolvedSource: undefined,
      preparedContent: undefined,
      fingerprint,
      inputFingerprint: fingerprint,
      fingerprintVersion: 'v2',
    });
    if (created.blocked) return { obligation: null, blocked: created.blocked };
    obligation = created.obligation!;
    await persistReviewObligation(sessDir, state, obligation);
    return {
      obligation,
      blocked: formatSubagentReviewNotInvoked(
        'no review obligation found — a fresh obligation has been created. Re-submit your findings with the toolObligationId from the returned requiredReviewAttestation.',
        obligation.obligationId,
      ),
    };
  }
  return { obligation };
}

export function validateSubmittedReviewFindings(
  state: SessionState,
  args: ReviewToolArgs,
  obligation: ReviewObligation,
): string | null {
  if (obligation.status === 'consumed') {
    return formatSubagentReviewNotInvoked(
      'this review obligation has already been consumed. Start a fresh /review to create a new obligation.',
      obligation.obligationId,
    );
  }

  const findings = args.reviewFindings as Record<string, unknown>;
  if ((findings.reviewMode as string) !== 'subagent') {
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
  if ((findings.overallVerdict as string) === 'unable_to_review') {
    return formatSubagentReviewNotInvoked(
      'reviewer returned overallVerdict "unable_to_review" — the content was declared unreviewable; this obligation is consumed and cannot pass review',
      obligation.obligationId,
    );
  }

  const challengeConsistency = validateChallengeConsistency({
    overallVerdict: findings.overallVerdict as 'accept' | 'changes_requested' | 'unable_to_review',
    requiredChallengeCount: obligation.requiredChallengeCount,
    requiredChallengeKind: obligation.requiredChallengeKind ?? 'implementation_challenge',
    challenges: findings.challenges as Parameters<
      typeof validateChallengeConsistency
    >[0]['challenges'],
    // Obligation-scope + evidence binding for content challenges (findings
    // B3/B5): a content challenge must carry the active obligation id and cite
    // the canonical content ref, not a fabricated digest.
    expectedObligationId: obligation.obligationId,
    allowedEvidenceRefs: buildHostTaskChallengeContract(state, obligation)?.evidenceRefs,
    resolutionVerdicts: findings.challengeResolutionVerdicts as Parameters<
      typeof validateChallengeConsistency
    >[0]['resolutionVerdicts'],
    previouslyUsedChallengeIds: collectPreviouslyUsedChallengeIds(state),
  });
  if (!challengeConsistency.ok) {
    return formatSubagentReviewNotInvoked(
      `${challengeConsistency.code}: ${JSON.stringify(challengeConsistency.details)}`,
      obligation.obligationId,
    );
  }

  const scopeRelations: FindingWithRelation[] = [];
  [findings.blockingIssues, findings.majorRisks].forEach((arr) => {
    if (Array.isArray(arr))
      arr.forEach((item) => {
        if (item && typeof item === 'object') scopeRelations.push(item as FindingWithRelation);
      });
  });
  const scopeResult = validateReviewFindingsScope({
    findings: scopeRelations,
    reviewSubjectScope: obligation.reviewSubjectScope,
    repositoryRevisionProvenance: obligation.repositoryRevisionProvenance,
  });
  if (!scopeResult.ok) {
    return formatSubagentReviewNotInvoked(
      scopeResult.code === 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE'
        ? `Reviewer findings do not relate to the reviewed subject scope at indexes: ${scopeResult.details.outOfScopeFindingIndexes.join(', ')}`
        : `Review subject scope could not be verified for obligation ${obligation.obligationId}`,
      obligation.obligationId,
    );
  }

  const verdict = validateStrictAttestation(
    findings as unknown as Parameters<typeof validateStrictAttestation>[0],
    {
      obligationId: obligation.obligationId,
      iteration: obligation.iteration,
      planVersion: obligation.planVersion,
    },
  );
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
  args: ReviewToolArgs,
  now: string,
  consumption?: {
    readonly acceptedInvocationId?: string | null;
    readonly effectiveReviewFindings?: ReviewFindings;
  },
): StartedReviewResult {
  if (!obligation) return result;
  return {
    ...result,
    state: {
      ...result.state,
      standaloneReviewFindings: [
        ...(result.state.standaloneReviewFindings ?? []),
        ...((consumption?.effectiveReviewFindings ?? args.reviewFindings)
          ? [consumption?.effectiveReviewFindings ?? args.reviewFindings!]
          : []),
      ],
      reviewAssurance: consumeReviewObligation(
        ensureReviewAssurance(result.state.reviewAssurance),
        obligation,
        now,
        consumption?.acceptedInvocationId ??
          findAcceptedInvocationForFindings(
            result.state.reviewAssurance,
            obligation,
            args.reviewFindings,
          )?.invocationId,
      ),
    },
  };
}
