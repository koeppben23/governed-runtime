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

import type {
  ArchitectureReviewCompletion,
  LoopVerdict,
  RevisionDelta,
  ReviewFindings,
} from '../../state/evidence.js';
import { validateAdrSections } from '../../state/evidence.js';

import {
  appendObligationWithAttempt,
  consumeReviewObligation,
  createReviewObligation,
  ensureReviewAssurance,
  findAcceptedInvocationForFindings,
  findLatestObligation,
  findLatestUnconsumedObligation,
  reviewObligationResponseFields,
  resolveFrozenReviewProfile,
} from '../review/assurance.js';

import { requireReviewFindings, resolveHostTaskEffectiveFindings } from './review-validation.js';
import { collectPreviouslyUsedChallengeIds } from '../review/challenge-history.js';
import { resolveRuntimeReviewPlatform } from '../review/orchestration-mode.js';
import { buildHostTaskChallengeContract } from '../review/host-task-policy.js';

import {
  PHASE_LABELS,
  buildArchitectureReviewCard,
  buildProductNextAction,
} from '../../presentation/index.js';
import { materializeReviewCardArtifact } from '../../adapters/workspace/index.js';
import { readConfig } from '../../adapters/persistence-config.js';
import { resolveNextAction } from '../../machine/next-action.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import { normalizeArchitectureClaims } from '../../state/proofgraph-approval.js';
import { projectArchitectureProofStatus } from '../proofgraph/proof-summary-projectors.js';

import {
  type ArchitectureArgs,
  type ArchitectureSession,
  buildArchitectureReviewInstruction,
} from './architecture-shared.js';
import { resolvePreImplementationChallengeClassification } from './pre-implementation-challenge.js';
import { headCommitFull } from '../../adapters/git.js';
import { freezeContextAuthority } from '../../rails/repository-authority.js';

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
      // Bind design-challenge evidence to the ADR's canonical allowed refs
      // (finding B3): a fabricated section/digest must not satisfy a challenge.
      allowedChallengeEvidenceRefs: buildHostTaskChallengeContract(state, pendingObligation ?? null)
        ?.evidenceRefs,
      previouslyUsedChallengeIds: collectPreviouslyUsedChallengeIds(state),
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
  currentAdr = {
    ...currentAdr,
    adrText: revisedText,
    digest: revisedDigest,
    ...(args.claims
      ? {
          claimDeclarations: {
            flow: 'architecture' as const,
            claims: normalizeArchitectureClaims(args.claims)!,
          },
        }
      : {}),
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
      ? {
          ...revision.currentAdr,
          reviewCompletion: resolveArchitectureReviewCompletion(
            iteration,
            policy.maxSelfReviewIterations,
            revision.revisionDelta,
            args.reviewVerdict as LoopVerdict,
          ),
          reviewFindings: newReviewFindings,
        }
      : {
          ...revision.currentAdr,
          reviewCompletion: resolveArchitectureReviewCompletion(
            iteration,
            policy.maxSelfReviewIterations,
            revision.revisionDelta,
            args.reviewVerdict as LoopVerdict,
          ),
        },
    selfReview: {
      iteration,
      maxIterations: policy.maxSelfReviewIterations,
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

async function persistAndFormatReviewResult(input: ReviewResultContext): Promise<string> {
  const iteration = input.session.state.selfReview!.iteration + 1;
  const completion = input.advanced.state.architecture?.reviewCompletion;
  const verdict = input.args.reviewVerdict as LoopVerdict;
  const context = { ...input, iteration };

  if (completion === 'review_exhausted') {
    getAdapterLogger().warn(
      'flowguard_architecture',
      'ADR review exhausted at iteration limit without reviewer approval',
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

  if (completion === 'reviewer_accepted' || completion === 'review_exhausted') {
    return persistAndFormatConvergedReview(context);
  }
  return persistAndFormatNonConvergedReview(context, verdict);
}

async function persistAndFormatConvergedReview(input: ReviewResultContext): Promise<string> {
  const { session, review, revision, advanced, iteration } = input;
  await writeStateWithArtifacts(session.sessDir, advanced.state);
  const reviewLabel = review.subagentEnabled ? 'Independent review' : 'ADR self-review';
  const completion = advanced.state.architecture?.reviewCompletion;
  const status =
    completion === 'review_exhausted'
      ? `${reviewLabel} reached the iteration limit (${iteration}/${session.policy.maxSelfReviewIterations}) ` +
        'without reviewer approval. Human approval is required.'
      : `${reviewLabel} accepted the ADR at iteration ${iteration}. Human approval is required.`;
  const resp: Record<string, unknown> = {
    phase: advanced.state.phase,
    status,
    adrId: revision.currentAdr.id,
    adrDigest: revision.currentAdr.digest,
    selfReviewIteration: iteration,
    next: formatEval(advanced.evalResult),
    _audit: { transitions: advanced.transitions },
  };
  attachLatestReview(resp, review.effectiveFindings, review.expectedPlanVersion, iteration);
  await attachReviewCard({
    resp,
    reviewFindings: review.effectiveFindings,
    session,
    revision,
    finalState: advanced.state,
    iteration,
    reviewCompletion: completion,
  });
  return appendNextAction(JSON.stringify(resp), advanced.state);
}

function attachLatestReview(
  resp: Record<string, unknown>,
  reviewFindings: ReviewFindings | undefined,
  expectedPlanVersion: number,
  hostIteration: number,
): void {
  if (!reviewFindings) return;
  resp.latestReview = {
    iteration: hostIteration,
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
  reviewCompletion: ArchitectureReviewCompletion | undefined;
}): Promise<void> {
  const { resp, reviewFindings, session, revision, finalState, iteration } = input;
  const nextAction = resolveNextAction(finalState.phase, finalState);
  const productNext = buildProductNextAction(nextAction, finalState.phase);
  const latestReview = resp.latestReview as Record<string, unknown> | undefined;
  const reviewCardInput = {
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
    isApproved: finalState.architecture?.status === 'accepted',
    reviewCompletion: input.reviewCompletion,
    proofSummary: projectArchitectureProofStatus(finalState),
  };
  // Cards and artifacts are canonical Unicode; only host-visible Markdown uses preferences.
  resp.reviewCard = buildArchitectureReviewCard(reviewCardInput);
  resp.presentation = {
    markdown: buildArchitectureReviewCard(reviewCardInput, {
      glyphProfile: (await readConfig(session.worktree)).presentation.opencode.glyphProfile,
    }),
  };
  const artifactErr = await materializeReviewCardArtifact(
    session.sessDir,
    'architecture-review-card',
    resp.reviewCard as string,
    finalState,
    revision.currentAdr.digest,
  );
  if (artifactErr) resp.artifactWarning = artifactErr;
}

function findPriorArchTargetPaths(
  assurance: NonNullable<SessionState['reviewAssurance']>,
): string[] | undefined {
  const obligations = [...assurance.obligations].reverse();
  const lastArch = obligations.find((o) => o.obligationType === 'architecture');
  const paths = lastArch?.metadata?.targetPaths;
  if (!Array.isArray(paths)) return undefined;
  const stringPaths: string[] = paths.filter((p: unknown): p is string => typeof p === 'string');
  return stringPaths.length === paths.length ? stringPaths : undefined;
}

/** Obligation metadata carrying the resolved target paths, when any were resolved. */
function targetPathsMetadata(resolved: readonly string[] | undefined): Record<string, unknown> {
  return resolved && resolved.length > 0 ? { targetPaths: [...resolved] } : {};
}

async function persistAndFormatNonConvergedReview(
  input: ReviewResultContext,
  verdict: LoopVerdict,
): Promise<string> {
  const { args, session, review, revision, advanced, iteration } = input;
  // Recover the prior obligation's paths and union them with any fresh author
  // targetPaths. Classification derives the rest from persisted discovery risk
  // surfaces (shared SSOT with Mode A) and NEVER dead-ends: an ADR revision that
  // carries no diff and no detected surface classifies as TRIVIAL, not a block.
  const priorTargetPaths = findPriorArchTargetPaths(
    ensureReviewAssurance(advanced.state.reviewAssurance),
  );
  const targetPaths = [...new Set([...(priorTargetPaths ?? []), ...(args.targetPaths ?? [])])];
  const classification = await resolvePreImplementationChallengeClassification(
    advanced.state,
    session.wsDir,
    review.subagentEnabled,
    targetPaths,
  );
  const resolvedTargetPaths =
    classification.kind === 'available' ? [...classification.changedFiles] : undefined;
  const headSha = await headCommitFull(session.wsDir);
  const nextObligation = review.subagentEnabled
    ? createReviewObligation({
        obligationType: 'architecture',
        iteration,
        planVersion: review.expectedPlanVersion,
        now: session.ctx.now(),
        subjectDigest: advanced.state.architecture?.digest ?? `arch-${review.expectedPlanVersion}`,
        reviewProfile: resolveFrozenReviewProfile(advanced.state.policySnapshot),
        profileSource: 'policy_default',
        policySnapshot: advanced.state.policySnapshot,
        changedFiles: resolvedTargetPaths,
        claimedTaskClass: advanced.state.claimedTaskClass,
        metadata: targetPathsMetadata(resolvedTargetPaths),
        // Frozen repository context (freeze-time resolution): architecture
        // reviews may cite repository evidence only against this context.
        repositoryAuthority: headSha ? freezeContextAuthority(session.wsDir, headSha) : undefined,
      })
    : null;
  let archAttemptId: string | null = null;
  const stateToPersist = nextObligation
    ? (() => {
        const withAttempt = appendObligationWithAttempt(
          advanced.state.reviewAssurance,
          nextObligation,
          session.ctx.now(),
        );
        archAttemptId = withAttempt.attemptId;
        return {
          ...advanced.state,
          reviewAssurance: withAttempt.assurance,
        };
      })()
    : advanced.state;
  const persisted = await writeStateWithArtifacts(session.sessDir, stateToPersist);
  const instruction = buildArchitectureReviewInstruction({
    policy: session.policy,
    subagentEnabled: review.subagentEnabled,
    obligation: nextObligation,
    iteration,
    planVersion: review.expectedPlanVersion,
    subjectLabel: 'revised ADR text, ADR title, and ticket text',
    state: persisted,
  });

  const resp: Record<string, unknown> = {
    phase: advanced.state.phase,
    status: `${review.subagentEnabled ? 'Independent review' : 'ADR self-review'} iteration ${iteration}/${session.policy.maxSelfReviewIterations}. Verdict: ${verdict}.`,
    adrId: revision.currentAdr.id,
    adrDigest: revision.currentAdr.digest,
    selfReviewIteration: iteration,
    revisionDelta: revision.revisionDelta,
    reviewMode: review.subagentEnabled ? 'subagent' : 'self',
    ...reviewObligationResponseFields(nextObligation, archAttemptId),
    next: instruction.next,
    ...(instruction.reviewInvocation ? { reviewInvocation: instruction.reviewInvocation } : {}),
    _audit: { transitions: advanced.transitions },
  };
  return appendNextAction(JSON.stringify(resp), stateToPersist);
}
