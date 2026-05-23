/**
 * @module integration/tools/architecture
 * @description FlowGuard architecture tool — submit ADR or record self-review verdict.
 *
 * Multi-call pattern driven by the LLM:
 *
 * Step 1: LLM generates ADR, calls flowguard_architecture({ title, adrText })
 *   -> Tool records ADR, initializes self-review loop, returns "self-review needed"
 *
 * Step 2: LLM reviews ADR critically, calls flowguard_architecture({
 *   reviewVerdict: "changes_requested", adrText: "revised..."
 * }) OR flowguard_architecture({ reviewVerdict: "approve" })
 *   -> Tool records iteration, checks convergence
 *
 * Repeat Step 2 until converged or max iterations (from policy).
 * On convergence: auto-advance to ARCH_REVIEW.
 *
 * @version v1
 */

import { z } from 'zod';

import type { ToolContext, ToolDefinition } from './helpers.js';
import {
  withMutableSession,
  formatEval,
  formatBlocked,
  formatError,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';

// State & Machine
import type { SessionState } from '../../state/schema.js';
import { evaluate } from '../../machine/evaluate.js';

// Rails
import { executeArchitecture } from '../../rails/architecture.js';

// Rail helpers
import { autoAdvance } from '../../rails/types.js';

// Evidence types
import type { LoopVerdict, RevisionDelta, ReviewFindings } from '../../state/evidence.js';
import {
  validateAdrSections,
  ReviewFindings as ReviewFindingsSchema,
} from '../../state/evidence.js';

// Review obligation helpers (F13: parity with plan/implement)
import {
  appendReviewObligation,
  consumeReviewObligation,
  createReviewObligation,
  ensureReviewAssurance,
  findAcceptedInvocationForFindings,
  findLatestObligation,
  findLatestUnconsumedObligation,
  reviewObligationResponseFields,
} from '../review/assurance.js';

// Review findings validation (shared with plan.ts and implement.ts; F13 slice 7c)
import { resolveHostTaskEffectiveFindings, requireReviewFindings } from './review-validation.js';

import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import {
  resolveRuntimeReviewPlatform,
  resolveReviewOrchestrationMode,
} from '../review/orchestration-mode.js';
import { buildPendingReviewInstruction } from '../review/pending-instruction.js';

// Presentation
import {
  PHASE_LABELS,
  buildArchitectureReviewCard,
  buildProductNextAction,
} from '../../presentation/index.js';
import { materializeReviewCardArtifact } from '../../adapters/workspace/index.js';
import { resolveNextAction } from '../../machine/next-action.js';

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_architecture — Submit ADR OR Self-Review Verdict (Multi-Mode)
// ═══════════════════════════════════════════════════════════════════════════════

type ArchitectureArgs = {
  title?: string;
  adrText?: string;
  reviewVerdict?: LoopVerdict;
  reviewFindings?: ReviewFindings;
  reviewerUnavailable?: boolean;
};

type ArchitectureSession = Awaited<ReturnType<typeof withMutableSession>>;

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

type AdvancedArchitectureState = ReturnType<typeof autoAdvanceArchitectureState>;

type ReviewResultContext = {
  args: ArchitectureArgs;
  session: ArchitectureSession;
  review: ResolvedReview;
  revision: AdrRevision;
  advanced: AdvancedArchitectureState;
  iteration: number;
};

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateInitialSubmissionGate(
  args: ArchitectureArgs,
  state: SessionState,
  isInitialSubmission: boolean,
): string | null {
  const hasTitle = hasText(args.title);
  const hasAdrText = hasText(args.adrText);

  if (hasTitle && hasText(args.reviewVerdict)) {
    return formatBlocked('ADR_SUBMISSION_MIXED_INPUTS');
  }

  if (!isInitialSubmission || (!hasTitle && !hasAdrText) || state.phase !== 'ARCHITECTURE') {
    return null;
  }
  if (!state.selfReview) return null;

  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const blockedArchObligations = assurance.obligations.filter(
    (o) => o.obligationType === 'architecture' && o.status === 'blocked',
  );
  const lastArchObligation = [...assurance.obligations]
    .reverse()
    .find((o) => o.obligationType === 'architecture');

  if (lastArchObligation?.status !== 'blocked') {
    return formatBlocked('ADR_REVIEW_IN_PROGRESS');
  }
  if (blockedArchObligations.length >= 3) {
    return formatBlocked('ORCHESTRATION_PERMANENTLY_FAILED', {
      attempts: String(blockedArchObligations.length),
    });
  }
  return null;
}

async function handleAdrSubmission(
  args: ArchitectureArgs,
  session: ArchitectureSession,
): Promise<string> {
  const { sessDir, state, policy, ctx } = session;
  if (!args.title) return formatBlocked('EMPTY_ADR_TITLE');
  if (!args.adrText) return formatBlocked('EMPTY_ADR_TEXT');

  const result = executeArchitecture(state, { title: args.title, adrText: args.adrText }, ctx);

  if (result.kind === 'blocked') {
    return JSON.stringify({
      error: true,
      code: result.code,
      message: result.reason,
      recovery: result.recovery,
      quickFix: result.quickFix,
    });
  }

  const subagentEnabled = policy.selfReview?.subagentEnabled ?? false;
  const archPlanVersion = 1;
  const nextObligation = subagentEnabled
    ? createReviewObligation({
        obligationType: 'architecture',
        iteration: 0,
        planVersion: archPlanVersion,
        now: ctx.now(),
      })
    : null;
  const augmentedState: SessionState = nextObligation
    ? {
        ...result.state,
        reviewAssurance: appendReviewObligation(result.state.reviewAssurance, nextObligation),
      }
    : result.state;

  await writeStateWithArtifacts(sessDir, augmentedState);

  const instruction = buildArchitectureReviewInstruction({
    policy: session.policy,
    subagentEnabled,
    obligation: nextObligation,
    iteration: 0,
    planVersion: archPlanVersion,
    subjectLabel: 'full ADR text, ADR title, and ticket text',
  });
  const modeAResponse: Record<string, unknown> = {
    phase: augmentedState.phase,
    status: `ADR ${augmentedState.architecture!.id} submitted: ${args.title}`,
    adrId: augmentedState.architecture!.id,
    adrDigest: augmentedState.architecture!.digest,
    selfReviewIteration: 0,
    maxSelfReviewIterations: policy.maxSelfReviewIterations,
    reviewMode: subagentEnabled ? 'subagent' : 'self',
    ...reviewObligationResponseFields(nextObligation),
    next: instruction.next,
    ...(instruction.reviewInvocation ? { reviewInvocation: instruction.reviewInvocation } : {}),
    _audit: { transitions: result.transitions },
  };

  return appendNextAction(JSON.stringify(modeAResponse), augmentedState);
}

function buildArchitectureReviewInstruction(input: {
  policy: ArchitectureSession['policy'];
  subagentEnabled: boolean;
  obligation: ReturnType<typeof createReviewObligation> | null;
  iteration: number;
  planVersion: number;
  subjectLabel: string;
}): {
  next: string;
  reviewInvocation?: ReturnType<typeof buildPendingReviewInstruction>['reviewInvocation'];
} {
  const { subagentEnabled } = input;
  if (!subagentEnabled) {
    return {
      next:
        'Self-review needed. Review the ADR critically against MADR standards. ' +
        'Check for completeness, clarity, and consequences coverage. ' +
        'Then call flowguard_architecture with reviewVerdict.',
    };
  }
  const platform = resolveRuntimeReviewPlatform();
  const mode = resolveReviewOrchestrationMode({
    platform,
    reviewInvocationPolicy: input.policy.reviewInvocationPolicy,
    nativeReviewerAvailable: platform === 'unknown' ? false : true,
    manualAttestedAllowed: input.policy.reviewInvocationPolicy !== 'host_task_required',
  });
  const instruction = buildPendingReviewInstruction({
    mode,
    platform,
    reviewKind: 'architecture',
    obligation: input.obligation,
    iteration: input.iteration,
    planVersion: input.planVersion,
    subjectLabel: input.subjectLabel,
  });
  return { next: instruction.next, reviewInvocation: instruction.reviewInvocation };
}

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
      findAcceptedInvocationForFindings(review.assuranceBase, strictObligation, args.reviewFindings)
        ?.invocationId,
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

function autoAdvanceArchitectureState(nextState: SessionState, session: ArchitectureSession) {
  const { policy, ctx } = session;
  const advanced = autoAdvance(nextState, (s: SessionState) => evaluate(s, policy), ctx);
  const finalState =
    advanced.state.phase === 'ARCH_COMPLETE' && advanced.state.architecture
      ? {
          ...advanced.state,
          architecture: { ...advanced.state.architecture, status: 'accepted' as const },
        }
      : advanced.state;
  return { ...advanced, state: finalState };
}

async function handleAdrReview(
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
  return persistAndFormatReviewResult({ args, session, review, revision, advanced, iteration: 0 });
}

async function persistAndFormatReviewResult(input: ReviewResultContext): Promise<string> {
  const iteration = input.session.state.selfReview!.iteration + 1;
  const verdict = input.args.reviewVerdict as LoopVerdict;
  const approvedConverged = input.revision.revisionDelta === 'none' && verdict === 'approve';
  const maxReached = iteration >= input.session.policy.maxSelfReviewIterations;
  const context = { ...input, iteration };

  if (maxReached && !approvedConverged) {
    await writeStateWithArtifacts(input.session.sessDir, input.advanced.state);
    return formatBlocked('MAX_REVIEW_ITERATIONS_REACHED', {
      iteration: String(iteration),
      maxIterations: String(input.session.policy.maxSelfReviewIterations),
      lastVerdict: verdict,
    });
  }
  if (approvedConverged) {
    return persistAndFormatConvergedReview(context);
  }
  return persistAndFormatNonConvergedReview(context, verdict);
}

async function persistAndFormatConvergedReview(input: ReviewResultContext): Promise<string> {
  const { args, session, review, revision, advanced, iteration } = input;
  await writeStateWithArtifacts(session.sessDir, advanced.state);
  const isComplete = advanced.state.phase === 'ARCH_COMPLETE';
  const resp: Record<string, unknown> = {
    phase: advanced.state.phase,
    status: review.subagentEnabled
      ? `Independent review converged at iteration ${iteration}. ADR ${isComplete ? 'approved' : 'ready for approval'}.`
      : `ADR self-review converged at iteration ${iteration}. ADR ${isComplete ? 'approved' : 'ready for approval'}.`,
    adrId: revision.currentAdr.id,
    adrDigest: revision.currentAdr.digest,
    selfReviewIteration: iteration,
    next: formatEval(advanced.evalResult),
    _audit: { transitions: advanced.transitions },
  };
  attachLatestReview(resp, args.reviewFindings, review.expectedPlanVersion);
  await attachReviewCard({
    resp,
    reviewFindings: args.reviewFindings,
    session,
    revision,
    finalState: advanced.state,
    iteration,
    isComplete,
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
    iteration,
    overallVerdict: latestReview?.overallVerdict as string | undefined,
    blockingIssues: reviewFindings?.blockingIssues,
    majorRisks: reviewFindings?.majorRisks,
    missingVerification: reviewFindings?.missingVerification,
    scopeCreep: reviewFindings?.scopeCreep,
    unknowns: reviewFindings?.unknowns,
    productNextAction: productNext,
    isApproved: isComplete,
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

export const architecture: ToolDefinition = {
  description:
    'Submit an Architecture Decision Record (ADR) OR record a self-review verdict. Two modes:\n' +
    'Mode A (submit ADR): provide title and adrText. ADR ID is auto-generated. Records the ADR and starts the review flow.\n' +
    "Mode B (review verdict): provide reviewVerdict ('approve' or 'changes_requested'). " +
    "If 'changes_requested', also provide revised adrText.\n" +
    'When subagentEnabled=true (the default for all built-in policies), the review is performed ' +
    `by the ${REVIEWER_SUBAGENT_TYPE} subagent and the verdict submission MUST include reviewFindings ` +
    'returned by that subagent. When subagentEnabled=false, the legacy LLM-driven self-review path is used.\n' +
    'The review loop runs up to maxIterations (from policy). ' +
    'On convergence, auto-advances to ARCH_REVIEW.\n' +
    'Only allowed in READY phase (starts the architecture flow) or ARCHITECTURE phase (re-submit after revision).\n' +
    'Optionally accepts reviewFindings from an independent review agent.',
  args: {
    title: z
      .string()
      .optional()
      .describe('Short title of the architecture decision. Required for Mode A.'),
    adrText: z
      .string()
      .optional()
      .describe(
        'Full ADR body in MADR Markdown format. ' +
          'Must include ## Context, ## Decision, and ## Consequences sections. ' +
          "Required for Mode A and when reviewVerdict is 'changes_requested'.",
      ),
    reviewVerdict: z
      .enum(['approve', 'changes_requested'])
      .optional()
      .describe(
        'Review verdict. Omit for initial ADR submission. ' +
          "'approve' = ADR is good, advance. " +
          "'changes_requested' = ADR needs revision, provide updated adrText.",
      ),
    reviewFindings: ReviewFindingsSchema.optional().describe(
      `Structured findings from the ${REVIEWER_SUBAGENT_TYPE} subagent. ` +
        'Required when reviewVerdict is "approve" and subagentEnabled=true. ' +
        'Use exactly the JSON object the subagent returned — do not modify it.',
    ),
    reviewerUnavailable: z
      .boolean()
      .optional()
      .describe(
        'Set to true when the reviewer subagent cannot be invoked (Task tool fails, ' +
          'agent unavailable). Allows self-review fallback in host_task_required mode.',
      ),
  },
  async execute(args, context) {
    try {
      const session = await withMutableSession(context);
      // BUG-21: Use typeof checks — `!== undefined` is true for null (which LLMs
      // may send for absent optional fields). Defense-in-depth.
      const hasVerdict = typeof args.reviewVerdict === 'string' && args.reviewVerdict.length > 0;
      const isInitialSubmission = !hasVerdict;

      const gateBlocked = validateInitialSubmissionGate(args, session.state, isInitialSubmission);
      if (gateBlocked) return gateBlocked;

      if (isInitialSubmission) {
        return handleAdrSubmission(args, session);
      }
      return handleAdrReview(args, context, session);
    } catch (err) {
      return formatError(err);
    }
  },
};
