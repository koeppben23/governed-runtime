/**
 * @module integration/tools/architecture-review
 * @description Mode B — ADR review/verdict flow.
 *
 * @version v1
 */

import type { ToolContext } from './helpers.js';
import {
  formatEval,
  formatBlocked,
  formatAutoAdvanceOverflow,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';

import type { SessionState } from '../../state/schema.js';
import { evaluate } from '../../machine/evaluate.js';
import { autoAdvance } from '../../rails/types.js';
import type { AutoAdvanceResult } from '../../rails/types.js';

import type { LoopVerdict, RevisionDelta, ReviewFindings } from '../../state/evidence.js';
import { validateAdrSections } from '../../state/evidence.js';

import {
  consumeReviewObligation,
  createReviewObligation,
  ensureReviewAssurance,
  findAcceptedInvocationForFindings,
  findLatestObligation,
  findLatestUnconsumedObligation,
  appendReviewObligation,
  reviewObligationResponseFields,
} from '../review/assurance.js';

import { requireReviewFindings, resolveHostTaskEffectiveFindings } from './review-validation.js';
import { resolveRuntimeReviewPlatform } from '../review/orchestration-mode.js';

import {
  PHASE_LABELS,
  buildArchitectureReviewCard,
  buildProductNextAction,
} from '../../presentation/index.js';
import { materializeReviewCardArtifact } from '../../adapters/workspace/index.js';
import { resolveNextAction } from '../../machine/next-action.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';

import {
  type ArchitectureArgs,
  type ArchitectureSession,
  buildArchitectureReviewInstruction,
} from './architecture-shared.js';

// ─── Mode-B Internal Types ────────────────────────────────────────────────

type ResolvedReview = {
  subagentEnabled: boolean;
  strictEnforcement: boolean;
  pendingObligation: ReturnType<typeof findLatestUnconsumedObligation>;
  expectedIteration: number;
  expectedPlanVersion: number;
  assuranceBase: ReturnType<typeof ensureReviewAssurance>;
  effectiveFindings?: ReviewFindings;
  evidenceInvocationId?: string;
};

type ReviewPolicyConfig = {
  subagentEnabled: boolean;
  fallbackToSelf: boolean;
  strictEnforcement: boolean;
};

type AdrRevision = {
  currentAdr: NonNullable<SessionState['architecture']>;
  prevDigest: string;
  revisionDelta: RevisionDelta;
};

type AdvancedArchitectureState = Extract<AutoAdvanceResult, { kind: 'advanced' }>;

type ReviewResultContext = {
  args: ArchitectureArgs;
  session: ArchitectureSession;
  review: ResolvedReview;
  revision: AdrRevision;
  advanced: AdvancedArchitectureState;
  iteration: number;
  /**
   * True when convergence was forced by reaching the iteration limit without
   * an approving verdict (last verdict was changes_requested). Drives honest,
   * non-"approved" messaging and the review-card warning banner.
   */
  forcedConvergence?: boolean;
};

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

function getReviewPolicyConfig(policy: ArchitectureSession['policy']): ReviewPolicyConfig {
  return {
    subagentEnabled: policy.selfReview?.subagentEnabled ?? false,
    fallbackToSelf: policy.selfReview?.fallbackToSelf ?? false,
    strictEnforcement: policy.selfReview?.strictEnforcement ?? false,
  };
}

function getObligationExpectation(
  pendingObligation: ReturnType<typeof findLatestUnconsumedObligation>,
  state: SessionState,
): { expectedIteration: number; expectedPlanVersion: number } {
  if (!pendingObligation) {
    return { expectedIteration: state.selfReview!.iteration, expectedPlanVersion: 1 };
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
  const { state, policy } = session;
  const reviewPolicy = getReviewPolicyConfig(policy);
  const assuranceBase = ensureReviewAssurance(state.reviewAssurance);
  const pendingObligation = findLatestUnconsumedObligation(assuranceBase, 'architecture');
  const { expectedIteration, expectedPlanVersion } = getObligationExpectation(
    pendingObligation,
    state,
  );
  const resolved = resolveHostTaskEffectiveFindings({
    pendingObligation,
    expected: {
      obligationType: 'architecture',
      iteration: expectedIteration,
      planVersion: expectedPlanVersion,
    },
    policy: {
      reviewInvocationPolicy: policy.reviewInvocationPolicy,
      strictEnforcement: reviewPolicy.strictEnforcement,
      subagentEnabled: reviewPolicy.subagentEnabled,
      fallbackToSelf: reviewPolicy.fallbackToSelf,
    },
    input: {
      reviewFindings: args.reviewFindings,
      reviewerUnavailable: args.reviewerUnavailable,
      verdict: args.reviewVerdict,
    },
    state: {
      assurance: state.reviewAssurance,
      sessionId: context.sessionID,
      reviewHostPlatform: resolveRuntimeReviewPlatform(),
    },
  });

  if (resolved.blocked) return resolved.blocked;

  const findingsBlocked = validateResolvedFindings(
    resolved.effectiveFindings,
    args.reviewVerdict,
    pendingObligation?.obligationId,
  );
  if (findingsBlocked) return findingsBlocked;

  return {
    subagentEnabled: reviewPolicy.subagentEnabled,
    strictEnforcement: reviewPolicy.strictEnforcement,
    pendingObligation,
    expectedIteration,
    expectedPlanVersion,
    assuranceBase,
    effectiveFindings: resolved.effectiveFindings,
    evidenceInvocationId: resolved.evidenceInvocationId,
  };
}

function validateResolvedFindings(
  effectiveFindings: ReviewFindings | undefined,
  submittedVerdict: LoopVerdict | undefined,
  obligationId: string | undefined,
): string | null {
  if (!effectiveFindings) return requireReviewFindings(false);
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
  const verdict = args.reviewVerdict as LoopVerdict;
  const prevDigest = state.architecture!.digest;
  let currentAdr = state.architecture!;
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
  currentAdr = { ...currentAdr, adrText: revisedText, digest: revisedDigest };
  return { currentAdr, prevDigest, revisionDelta };
}

function buildReviewedState(
  revision: AdrRevision,
  review: ResolvedReview,
  args: ArchitectureArgs,
  session: ArchitectureSession,
): SessionState {
  const { state, policy, ctx } = session;
  const iteration = state.selfReview!.iteration + 1;
  const existingReviewFindings = state.architecture!.reviewFindings;
  const newReviewFindings = review.effectiveFindings
    ? [...(existingReviewFindings ?? []), review.effectiveFindings]
    : existingReviewFindings;
  const strictObligation = review.strictEnforcement
    ? findLatestObligation(
        review.assuranceBase.obligations,
        'architecture',
        review.expectedIteration,
        review.expectedPlanVersion,
      )
    : null;
  const consumedAssurance = consumeReviewObligation(
    review.assuranceBase,
    strictObligation,
    ctx.now(),
    review.evidenceInvocationId ??
      findAcceptedInvocationForFindings(
        review.assuranceBase,
        strictObligation,
        review.effectiveFindings,
      )?.invocationId,
  );

  return {
    ...state,
    architecture: newReviewFindings
      ? { ...revision.currentAdr, reviewFindings: newReviewFindings }
      : revision.currentAdr,
    selfReview: {
      iteration,
      maxIterations: policy.maxSelfReviewIterations,
      prevDigest: revision.prevDigest,
      currDigest: revision.currentAdr.digest,
      revisionDelta: revision.revisionDelta,
      verdict: args.reviewVerdict as LoopVerdict,
    },
    reviewAssurance: {
      obligations: consumedAssurance.obligations,
      invocations: consumedAssurance.invocations,
    },
    error: null,
  };
}

function autoAdvanceArchitectureState(
  nextState: SessionState,
  session: ArchitectureSession,
): AutoAdvanceResult {
  const { policy, ctx } = session;
  const advanced = autoAdvance(nextState, (s: SessionState) => evaluate(s, policy), ctx);
  if (advanced.kind === 'overflow') {
    return advanced;
  }
  const finalState =
    advanced.state.phase === 'ARCH_COMPLETE' && advanced.state.architecture
      ? {
          ...advanced.state,
          architecture: { ...advanced.state.architecture, status: 'accepted' as const },
        }
      : advanced.state;
  return { ...advanced, state: finalState };
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

async function persistAndFormatReviewResult(input: ReviewResultContext): Promise<string> {
  const iteration = input.session.state.selfReview!.iteration + 1;
  const verdict = input.args.reviewVerdict as LoopVerdict;
  const approvedConverged = input.revision.revisionDelta === 'none' && verdict === 'accept';
  const maxReached = iteration >= input.session.policy.maxSelfReviewIterations;

  // Force-convergence: the review loop exhausted its iteration budget without
  // an approving verdict. Parity with the plan and implementation review flows:
  // NEVER block here. Route through the converged path so human-gated modes
  // stop at ARCH_REVIEW for the human to decide, and auto-approve modes finalize
  // with an honest, audit-visible status. The previous hard block stranded the
  // session at ARCH_REVIEW while its recovery told the user to run a command
  // inadmissible at that phase.
  const forcedConvergence = maxReached && !approvedConverged;
  const context = { ...input, iteration, forcedConvergence };

  if (forcedConvergence) {
    getAdapterLogger().warn(
      'flowguard_architecture',
      'ADR review force-converged at iteration limit without reviewer approval',
      {
        sessDir: input.session.sessDir,
        iteration,
        maxIterations: input.session.policy.maxSelfReviewIterations,
        lastVerdict: verdict,
        phase: input.advanced.state.phase,
        adrDigest: input.revision.currentAdr.digest,
      },
    );
  }

  if (approvedConverged || forcedConvergence) {
    return persistAndFormatConvergedReview(context);
  }
  return persistAndFormatNonConvergedReview(context, verdict);
}

async function persistAndFormatConvergedReview(input: ReviewResultContext): Promise<string> {
  const { args, session, review, revision, advanced, iteration, forcedConvergence } = input;
  await writeStateWithArtifacts(session.sessDir, advanced.state);
  const isComplete = advanced.state.phase === 'ARCH_COMPLETE';
  const reviewLabel = review.subagentEnabled ? 'Independent review' : 'ADR self-review';
  const status = forcedConvergence
    ? `${reviewLabel} reached the iteration limit (${iteration}/${session.policy.maxSelfReviewIterations}) ` +
      `without reviewer approval (last verdict: ${args.reviewVerdict}). ` +
      `${isComplete ? 'ADR auto-finalized.' : 'Your decision is required.'}`
    : `${reviewLabel} converged at iteration ${iteration}. ADR ${isComplete ? 'approved' : 'ready for approval'}.`;
  const resp: Record<string, unknown> = {
    phase: advanced.state.phase,
    status,
    adrId: revision.currentAdr.id,
    adrDigest: revision.currentAdr.digest,
    selfReviewIteration: iteration,
    next: formatEval(advanced.evalResult),
    _audit: { transitions: advanced.transitions },
  };
  attachLatestReview(resp, review.effectiveFindings, review.expectedPlanVersion);
  await attachReviewCard({
    resp,
    reviewFindings: review.effectiveFindings,
    session,
    revision,
    finalState: advanced.state,
    iteration,
    isComplete,
    forcedConvergence: forcedConvergence ?? false,
  });
  return appendNextAction(JSON.stringify(resp), advanced.state);
}

function attachLatestReview(
  resp: Record<string, unknown>,
  reviewFindings: ReviewFindings | undefined,
  expectedPlanVersion: number,
): void {
  if (!reviewFindings) return;
  resp.latestReview = {
    iteration: reviewFindings.iteration,
    planVersion: expectedPlanVersion,
    overallVerdict: reviewFindings.overallVerdict,
    blockingIssueCount: reviewFindings.blockingIssues.length,
    majorRiskCount: reviewFindings.majorRisks.length,
    missingVerificationCount: reviewFindings.missingVerification.length,
    reviewMode: reviewFindings.reviewMode,
    reviewedAt: reviewFindings.reviewedAt,
  };
}

async function attachReviewCard(input: {
  resp: Record<string, unknown>;
  reviewFindings: ReviewFindings | undefined;
  session: ArchitectureSession;
  revision: AdrRevision;
  finalState: SessionState;
  iteration: number;
  isComplete: boolean;
  forcedConvergence: boolean;
}): Promise<void> {
  const { resp, reviewFindings, session, revision, finalState, iteration, isComplete } = input;
  const nextAction = resolveNextAction(finalState.phase, finalState);
  const productNext = buildProductNextAction(nextAction, finalState.phase);
  const latestReview = resp.latestReview as Record<string, unknown> | undefined;
  resp.reviewCard = buildArchitectureReviewCard({
    phase: finalState.phase,
    phaseLabel: PHASE_LABELS[finalState.phase],
    adrTitle: revision.currentAdr.title,
    adrId: revision.currentAdr.id,
    adrDigest: revision.currentAdr.digest,
    adrText: revision.currentAdr.adrText,
    iteration,
    overallVerdict: latestReview?.overallVerdict as string | undefined,
    blockingIssues: reviewFindings?.blockingIssues,
    majorRisks: reviewFindings?.majorRisks,
    missingVerification: reviewFindings?.missingVerification,
    scopeCreep: reviewFindings?.scopeCreep,
    unknowns: reviewFindings?.unknowns,
    productNextAction: productNext,
    isApproved: isComplete,
    forcedConvergence: input.forcedConvergence,
  });
  const artifactErr = await materializeReviewCardArtifact(
    session.sessDir,
    'architecture-review-card',
    resp.reviewCard as string,
    finalState,
    revision.currentAdr.digest,
  );
  if (artifactErr) resp.artifactWarning = artifactErr;
}

async function persistAndFormatNonConvergedReview(
  input: ReviewResultContext,
  verdict: LoopVerdict,
): Promise<string> {
  const { session, review, revision, advanced, iteration } = input;
  const nextObligation = review.subagentEnabled
    ? createReviewObligation({
        obligationType: 'architecture',
        iteration,
        planVersion: review.expectedPlanVersion,
        now: session.ctx.now(),
      })
    : null;
  const stateToPersist = nextObligation
    ? {
        ...advanced.state,
        reviewAssurance: appendReviewObligation(advanced.state.reviewAssurance, nextObligation),
      }
    : advanced.state;
  await writeStateWithArtifacts(session.sessDir, stateToPersist);
  const instruction = buildArchitectureReviewInstruction({
    policy: session.policy,
    subagentEnabled: review.subagentEnabled,
    obligation: nextObligation,
    iteration,
    planVersion: review.expectedPlanVersion,
    subjectLabel: 'revised ADR text, ADR title, and ticket text',
  });

  const resp: Record<string, unknown> = {
    phase: advanced.state.phase,
    status: `${review.subagentEnabled ? 'Independent review' : 'ADR self-review'} iteration ${iteration}/${session.policy.maxSelfReviewIterations}. Verdict: ${verdict}.`,
    adrId: revision.currentAdr.id,
    adrDigest: revision.currentAdr.digest,
    selfReviewIteration: iteration,
    revisionDelta: revision.revisionDelta,
    reviewMode: review.subagentEnabled ? 'subagent' : 'self',
    ...reviewObligationResponseFields(nextObligation),
    next: instruction.next,
    ...(instruction.reviewInvocation ? { reviewInvocation: instruction.reviewInvocation } : {}),
    _audit: { transitions: advanced.transitions },
  };
  return appendNextAction(JSON.stringify(resp), stateToPersist);
}
