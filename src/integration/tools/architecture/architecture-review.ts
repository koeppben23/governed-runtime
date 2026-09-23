/**
 * @module integration/tools/architecture/architecture-review
 * @description Mode B — ADR review/verdict flow.
 *
 * @version v1
 */

import { getAdapterLogger } from '../../../logging/adapter-logger.js';
import type { ToolContext } from '../helpers.js';
import { formatBlocked } from '../../blocked-result.js';
import { formatAutoAdvanceOverflow } from '../helpers.js';

import type { SessionState } from '../../../state/schema.js';
import { evaluate } from '../../../machine/evaluate.js';
import { autoAdvance } from '../../../rails/types.js';
import type { AutoAdvanceResult } from '../../../rails/types.js';

import type {
  ArchitectureReviewCompletion,
  LoopVerdict,
  RevisionDelta,
  ReviewFindings,
} from '../../../state/evidence.js';
import { validateAdrSections } from '../../../state/evidence.js';
import {
  consumeReviewObligation,
  findLatestObligation,
  findLatestUnconsumedObligation,
} from '../../review/obligations/assurance.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';

import { resolveStructuredEffectiveFindings } from '../../review/validation/review-validation.js';
import { formatStructuredResolutionFailure } from '../../review/validation/review-validation-failure.js';
import { collectPreviouslyUsedChallengeIds } from '../../review/obligations/challenge-history.js';
import { buildReviewChallengeContract } from '../../review/obligations/challenge-contract.js';

import { normalizeArchitectureClaims } from '../../../state/proofgraph-approval.js';

import type { ArchitectureArgs, ArchitectureSession } from './architecture-shared.js';
import { IntegrationInvariantError } from '../../errors.js';
import {
  persistAndFormatReviewResult,
  type AdrRevision,
  type ResolvedReview,
} from './architecture-review-response.js';

// ═══════════════════════════════════════════════════════════════════════════
// Mode B: Self-Review Verdict
// ═══════════════════════════════════════════════════════════════════════════

function validateReviewEntryState(state: SessionState): string | null {
  if (state.phase !== 'ARCHITECTURE') {
    return formatBlocked('COMMAND_NOT_ALLOWED', { command: '/architecture', phase: state.phase });
  }
  if (!state.architecture) return formatBlocked('NO_ARCHITECTURE');
  if (!state.selfReview) return formatBlocked('ARCHITECTURE_REVIEW_LOOP_REQUIRED');
  return null;
}

function getObligationExpectation(
  pendingObligation: ReturnType<typeof findLatestUnconsumedObligation>,
  state: SessionState,
): { expectedIteration: number; expectedPlanVersion: number } {
  if (!pendingObligation) {
    const selfReview = state.selfReview;
    if (!selfReview) {
      throw new IntegrationInvariantError(
        'ARCHITECTURE_REVIEW_LOOP_REQUIRED',
        'ADR review expectations require a self-review loop in state',
      );
    }
    return { expectedIteration: selfReview.iteration, expectedPlanVersion: 1 };
  }
  return {
    expectedIteration: pendingObligation.iteration,
    expectedPlanVersion: pendingObligation.planVersion,
  };
}

function resolveArchitectureReview(
  args: ArchitectureArgs,
  context: ToolContext,
  session: ArchitectureSession,
): ResolvedReview | string {
  const { state } = session;
  const assuranceBase = ensureReviewAssurance(state.reviewAssurance);
  const pendingObligation = findLatestUnconsumedObligation(assuranceBase, 'architecture');
  const { expectedIteration, expectedPlanVersion } = getObligationExpectation(
    pendingObligation,
    state,
  );
  const resolved = resolveStructuredEffectiveFindings({
    pendingObligation,
    expected: {
      obligationType: 'architecture',
      iteration: expectedIteration,
      planVersion: expectedPlanVersion,
    },
    input: {
      reviewerUnavailable: args.reviewerUnavailable,
      verdict: args.reviewVerdict,
    },
    state: {
      assurance: state.reviewAssurance,
      sessionId: context.sessionID,
      // Bind design-challenge evidence to the ADR's canonical allowed refs
      // (finding B3): a fabricated section/digest must not satisfy a challenge.
      allowedChallengeEvidenceRefs: buildReviewChallengeContract(state, pendingObligation ?? null)
        ?.evidenceRefs,
      previouslyUsedChallengeIds: collectPreviouslyUsedChallengeIds(state),
    },
  });

  if (resolved.kind === 'blocked') {
    return formatStructuredResolutionFailure(getAdapterLogger(), resolved.failure);
  }

  const findingsBlocked = validateResolvedFindings(
    resolved.effectiveFindings,
    args.reviewVerdict,
    pendingObligation?.obligationId,
  );
  if (findingsBlocked) return findingsBlocked;

  return {
    pendingObligation,
    expectedIteration,
    expectedPlanVersion,
    assuranceBase,
    effectiveFindings: resolved.effectiveFindings,
    evidenceInvocationId: resolved.evidenceInvocationId,
  };
}

function validateResolvedFindings(
  effectiveFindings: ReviewFindings,
  submittedVerdict: LoopVerdict | undefined,
  obligationId: string | undefined,
): string | null {
  if (effectiveFindings.overallVerdict === 'unable_to_review') {
    return formatBlocked('SUBAGENT_UNABLE_TO_REVIEW', { obligationId: obligationId ?? 'unknown' });
  }
  if (effectiveFindings.overallVerdict !== submittedVerdict) {
    return formatBlocked('SUBAGENT_FINDINGS_VERDICT_MISMATCH', {
      submittedVerdict: submittedVerdict ?? 'unknown',
      findingsVerdict: effectiveFindings.overallVerdict,
    });
  }
  return null;
}

function applyAdrRevision(
  args: ArchitectureArgs,
  session: ArchitectureSession,
): AdrRevision | string {
  const { state, ctx } = session;
  const architecture = state.architecture;
  if (!architecture) return formatBlocked('NO_ARCHITECTURE');
  const verdict = args.reviewVerdict as LoopVerdict;
  const prevDigest = architecture.digest;
  let currentAdr = architecture;
  let revisionDelta: RevisionDelta = 'none';

  if (verdict !== 'changes_requested') return { currentAdr, prevDigest, revisionDelta };

  const revisedText = args.adrText?.trim();
  if (!revisedText) return formatBlocked('EMPTY_ADR_TEXT');
  const missingSections = validateAdrSections(revisedText);
  if (missingSections.length > 0) {
    return formatBlocked('MISSING_ADR_SECTIONS', { sections: missingSections.join(', ') });
  }

  const revisedDigest = ctx.digest(revisedText);
  revisionDelta = revisedDigest === prevDigest ? 'none' : 'minor';
  let claimDeclarations:
    | {
        flow: 'architecture';
        claims: NonNullable<ReturnType<typeof normalizeArchitectureClaims>>;
      }
    | undefined;
  if (args.claims) {
    const normalizedClaims = normalizeArchitectureClaims(args.claims);
    if (normalizedClaims === undefined) {
      throw new IntegrationInvariantError(
        'PROOFGRAPH_CLAIM_NORMALIZATION_UNAVAILABLE',
        'normalizing submitted architecture claims produced no canonical declarations',
      );
    }
    claimDeclarations = { flow: 'architecture', claims: normalizedClaims };
  }
  currentAdr = {
    ...currentAdr,
    adrText: revisedText,
    digest: revisedDigest,
    ...(claimDeclarations ? { claimDeclarations } : {}),
    // A revision makes a prior human approval attest to a superseded ADR.
    approvalCertificate: undefined,
  };
  return { currentAdr, prevDigest, revisionDelta };
}

function buildReviewedState(
  revision: AdrRevision,
  review: ResolvedReview,
  args: ArchitectureArgs,
  session: ArchitectureSession,
): SessionState {
  const { state, policy, ctx } = session;
  const selfReview = state.selfReview;
  const architecture = state.architecture;
  if (!selfReview || !architecture) {
    throw new IntegrationInvariantError(
      'ARCHITECTURE_REVIEW_STATE_REQUIRED',
      'ADR review persistence requires architecture and self-review state',
    );
  }
  const iteration = selfReview.iteration + 1;
  // Only host-captured effective findings are ever appended.
  const existingReviewFindings = architecture.reviewFindings;
  const newReviewFindings = [...(existingReviewFindings ?? []), review.effectiveFindings];
  const strictObligation = findLatestObligation(
    review.assuranceBase.obligations,
    'architecture',
    review.expectedIteration,
    review.expectedPlanVersion,
  );
  const consumedAssurance = consumeReviewObligation(
    review.assuranceBase,
    strictObligation,
    ctx.now(),
    review.evidenceInvocationId,
  );

  return {
    ...state,
    architecture: {
      ...revision.currentAdr,
      reviewCompletion: resolveArchitectureReviewCompletion(
        iteration,
        policy.reviewBudget.architecture,
        revision.revisionDelta,
        args.reviewVerdict as LoopVerdict,
      ),
      reviewFindings: newReviewFindings,
    },
    selfReview: {
      iteration,
      reviewCycle: state.reviewCycles.architecture,
      maxIterations: policy.reviewBudget.architecture,
      prevDigest: revision.prevDigest,
      currDigest: revision.currentAdr.digest,
      revisionDelta: revision.revisionDelta,
      verdict: args.reviewVerdict as LoopVerdict,
    },
    reviewAssurance: {
      ...consumedAssurance,
    },
    error: null,
  };
}

function resolveArchitectureReviewCompletion(
  iteration: number,
  maxIterations: number,
  revisionDelta: RevisionDelta,
  verdict: LoopVerdict,
): ArchitectureReviewCompletion {
  const reviewerAccepted = revisionDelta === 'none' && verdict === 'accept';
  if (reviewerAccepted) return 'reviewer_accepted';
  if (iteration >= maxIterations) return 'review_exhausted';
  return 'pending';
}

function autoAdvanceArchitectureState(
  nextState: SessionState,
  session: ArchitectureSession,
): AutoAdvanceResult {
  const { policy, ctx } = session;
  return autoAdvance(nextState, (s: SessionState) => evaluate(s, policy), ctx);
}

export async function handleAdrReview(
  args: ArchitectureArgs,
  context: ToolContext,
  session: ArchitectureSession,
): Promise<string> {
  const blocked = validateReviewEntryState(session.state);
  if (blocked) return blocked;
  const review = resolveArchitectureReview(args, context, session);
  if (typeof review === 'string') return review;
  const revision = applyAdrRevision(args, session);
  if (typeof revision === 'string') return revision;

  const reviewedState = buildReviewedState(revision, review, args, session);
  const advanced = autoAdvanceArchitectureState(reviewedState, session);
  // #428: fail closed on overflow BEFORE persistence — no partially-advanced write.
  if (advanced.kind === 'overflow') {
    return formatAutoAdvanceOverflow(advanced);
  }
  return persistAndFormatReviewResult({ args, session, review, revision, advanced, iteration: 0 });
}
