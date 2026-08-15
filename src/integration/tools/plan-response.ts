/**
 * @module integration/tools/plan-response
 * @description Plan tool response builders and persistence functions.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { PlanEvidence, ReviewFindings, ReviewObligation } from '../../state/evidence.js';
import {
  freezeContextAuthorityAtHead,
  freezeOutcomeRecord,
  frozenAuthorityOrUndefined,
  type RepositoryAuthorityFreezeResult,
} from '../../rails/repository-authority.js';
import { resolveAttemptDiscoveryOrBlock } from '../review/discovery-attempt-context.js';
import type {
  PlanExecutionScope,
  PlanRevisionResult,
  PlanSubmissionResponseInput,
  ConvergedPlanReviewInput,
} from './plan-types.js';
import {
  formatEval,
  formatAutoAdvanceOverflow,
  formatBlocked,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';
import {
  PHASE_LABELS,
  buildProductNextAction,
  buildPlanReviewCard,
} from '../../presentation/index.js';
import { materializeReviewCardArtifact } from '../../adapters/workspace/index.js';
import { readConfig } from '../../adapters/persistence-config.js';
import { resolveNextAction } from '../../machine/next-action.js';
import { evaluate } from '../../machine/evaluate.js';
import { autoAdvance } from '../../rails/types.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import {
  reviewObligationResponseFields,
  artifactReviewSubjectScope,
  createObligationAndAttempt,
  freezeReviewMaterial,
  findLatestObligation,
  resolveFrozenReviewProfile,
} from '../review/assurance.js';
import { buildFrozenReviewMaterialContent } from '../review/reviewer-context.js';
import { buildPendingReviewInstruction } from '../review/pending-instruction.js';
import { resolveAttemptObservationCapability } from '../review/assurance.js';
import { repositoryEvidenceUnavailableField } from '../review/observation-access.js';
import {
  resolveReviewedArtifactIdentity,
  reviewedIdentityFields,
} from '../review/reviewed-digest.js';
import { buildReviewerProofContext } from '../review/proof-context.js';
import { buildHeuristicRiskWarning } from '../proofgraph/claim-contract.js';
import { assessMinimumTaskClass } from '../phase-tool-gate.js';
import {
  resolveRuntimeReviewPlatform,
  resolveReviewOrchestrationMode,
} from '../review/orchestration-mode.js';
import { resolvePreImplementationChallengeClassification } from './pre-implementation-challenge.js';
import { projectPlanProofStatus } from '../proofgraph/proof-summary-projectors.js';

function findPriorPlanTargetPaths(
  assurance: import('../../state/schema.js').SessionState['reviewAssurance'],
): string[] | undefined {
  if (!assurance) return undefined;
  const obligations = [...assurance.obligations].reverse();
  const lastPlan = obligations.find((o) => o.obligationType === 'plan');
  const paths = lastPlan?.metadata?.targetPaths;
  return Array.isArray(paths) && paths.every((p: unknown) => typeof p === 'string')
    ? paths
    : undefined;
}

/** Extract the first non-empty line of text, truncated to 120 characters. */
export function firstLine(text: string | undefined): string | undefined {
  if (text == null) return undefined;
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return line.length > 120 ? line.slice(0, 117) + '...' : line;
}

/**
 * Build the canonical plan review obligation input for the initial submission.
 * The frozen plan artifact is the review SUBJECT; changedFiles stay
 * challenge-classification and repository-evidence context only. The frozen
 * repository authority (freeze-time resolution) is carried here so absence of
 * authority makes repository evidence unavailable.
 */
export function buildPlanReviewObligationInput(
  scope: PlanExecutionScope,
  planEvidence: PlanEvidence,
  planVersion: number,
  classificationFiles: readonly string[] | undefined,
  freeze: RepositoryAuthorityFreezeResult,
): Parameters<typeof createObligationAndAttempt>[1] {
  const metadata: Record<string, unknown> = {};
  if (classificationFiles && classificationFiles.length > 0) {
    metadata.targetPaths = [...classificationFiles];
  }
  return {
    obligationType: 'plan',
    iteration: 0,
    planVersion,
    now: scope.ctx.now(),
    subjectDigest: planEvidence.digest,
    // Frozen review material: the exact plan artifact plus originating
    // ticket context, canonicalized and digest-bound at creation time.
    reviewMaterial: freezeReviewMaterial(
      buildFrozenReviewMaterialContent({
        obligationType: 'plan',
        state: scope.state,
        artifact: planEvidence.body,
      }),
      planEvidence.digest,
    ),
    reviewSubjectScope: artifactReviewSubjectScope('plan', planEvidence.body, planEvidence.digest),
    reviewProfile: resolveFrozenReviewProfile(scope.state.policySnapshot),
    profileSource: 'policy_default',
    policySnapshot: scope.state.policySnapshot,
    changedFiles: classificationFiles,
    claimedTaskClass: scope.state.claimedTaskClass,
    metadata,
    repositoryAuthority: frozenAuthorityOrUndefined(freeze),
    // Durable freeze outcome: continuations and forensics render the exact
    // degradation cause from persisted state.
    repositoryEvidenceFreeze: freezeOutcomeRecord(freeze),
  };
}

function planRepositoryEvidenceWarning(
  nextObligation: ReviewObligation | null,
): Record<string, unknown> {
  return nextObligation
    ? repositoryEvidenceUnavailableField(nextObligation.repositoryEvidenceFreeze)
    : {};
}

export function buildPlanSubmissionResponse(
  input: PlanSubmissionResponseInput,
): Record<string, unknown> {
  const { scope, finalState, planEvidence, planVersion, reviewFindings, transitions } = input;
  const nextObligation = scope.reviewPolicy.subagentEnabled
    ? findLatestObligation(finalState.reviewAssurance?.obligations ?? [], 'plan', 0, planVersion)
    : null;
  const planAttemptId = nextObligation
    ? (finalState.reviewAssurance?.attempts?.find(
        (a) => a.obligationId === nextObligation.obligationId && a.status === 'created',
      )?.attemptId ?? null)
    : null;
  const reviewInstruction = buildPlanReviewInstruction({
    scope,
    obligation: nextObligation,
    iteration: 0,
    planVersion,
    subjectLabel: 'full plan text and ticket text',
    state: finalState,
  });
  const response: Record<string, unknown> = {
    phase: finalState.phase,
    status: 'Plan submitted (v' + planVersion + ').',
    planDigest: planEvidence.digest,
    selfReviewIteration: 0,
    maxSelfReviewIterations: scope.maxSelfReviewIterations,
    reviewMode: scope.reviewPolicy.subagentEnabled ? 'subagent' : 'self',
    ...reviewObligationResponseFields(nextObligation, planAttemptId),
    ...planRepositoryEvidenceWarning(nextObligation),
    next: reviewInstruction.next,
    reviewInvocation: reviewInstruction.reviewInvocation,
    _audit: { transitions },
  };
  const riskWarning = planRiskWarning(scope);
  if (riskWarning) response.proofGraphRiskWarning = riskWarning;
  if (reviewFindings)
    response.latestReview = latestPlanReviewSummary(
      finalState.reviewAssurance,
      reviewFindings,
      planVersion,
    );
  return response;
}

/** #762: advisory only. Surfaces a foreseeable late block early; never gates. */
function planRiskWarning(scope: PlanExecutionScope): ReturnType<typeof buildHeuristicRiskWarning> {
  return buildHeuristicRiskWarning({
    targetPaths: scope.args.targetPaths,
    assessedTaskClass: assessMinimumTaskClass(scope.args.targetPaths ?? []).minimumTaskClass,
    criticalClaimCount: (scope.args.claims ?? []).filter((claim) => claim.critical).length,
  });
}

export function buildPlanReviewInstruction(input: {
  scope: PlanExecutionScope;
  obligation: ReturnType<typeof findLatestObligation>;
  iteration: number;
  planVersion: number;
  subjectLabel: string;
  /** State whose declarations/graph the reviewer prompt must reflect (#762). */
  state: SessionState;
}) {
  const platform = resolveRuntimeReviewPlatform();
  const mode = resolveReviewOrchestrationMode({
    platform,
    reviewInvocationPolicy: input.scope.policy.reviewInvocationPolicy,
    nativeReviewerAvailable: platform === 'unknown' ? false : true,
    manualAttestedAllowed: input.scope.policy.reviewInvocationPolicy !== 'host_task_required',
  });
  return buildPendingReviewInstruction({
    mode,
    platform,
    reviewKind: 'plan',
    obligation: input.obligation,
    iteration: input.iteration,
    planVersion: input.planVersion,
    subjectLabel: input.subjectLabel,
    proofContext: buildReviewerProofContext(input.state),
    observationCapability: input.obligation
      ? (resolveAttemptObservationCapability(
          input.state.reviewAssurance,
          input.obligation.obligationId,
        ) ?? undefined)
      : undefined,
  });
}

export function latestPlanReviewSummary(
  assurance: SessionState['reviewAssurance'],
  reviewFindings: ReviewFindings,
  planVersion: number,
): Record<string, unknown> {
  return {
    iteration: reviewFindings.iteration,
    planVersion,
    overallVerdict: reviewFindings.overallVerdict,
    blockingIssueCount: reviewFindings.blockingIssues.length,
    majorRiskCount: reviewFindings.majorRisks.length,
    missingVerificationCount: reviewFindings.missingVerification.length,
    reviewMode: reviewFindings.reviewMode,
    reviewedAt: reviewFindings.reviewedAt,
    ...reviewedIdentityFields(resolveReviewedArtifactIdentity(assurance, 'plan', reviewFindings)),
  };
}

export function convergedPlanResponse(input: ConvergedPlanReviewInput): Record<string, unknown> {
  const { scope, finalState, ev, transitions, revision, iteration, forcedConvergence } = input;
  return {
    phase: finalState.phase,
    status: forcedConvergence
      ? `Independent review reached the iteration limit (${iteration}/${scope.maxSelfReviewIterations}) without reviewer approval (last verdict: ${revision.verdict}). Workflow advanced to ${finalState.phase}.`
      : `Independent review converged at iteration ${iteration}. Workflow advanced to ${finalState.phase}.`,
    planDigest: revision.currentPlan.digest,
    selfReviewIteration: iteration,
    next: formatEval(ev),
    _audit: { transitions },
  };
}

export async function convergedPlanReviewCardResponse(
  input: ConvergedPlanReviewInput,
): Promise<Record<string, unknown>> {
  const { scope, finalState, ev, transitions, revision, iteration, forcedConvergence } = input;
  const nextAction = resolveNextAction(finalState.phase, finalState);
  const productNext = buildProductNextAction(nextAction, finalState.phase);
  const reviewedIdentity = resolveReviewedArtifactIdentity(
    finalState.reviewAssurance,
    'plan',
    finalState.plan?.reviewFindings?.at(-1),
  );
  const reviewCardInput = {
    planText: revision.currentPlan.body,
    phase: finalState.phase,
    phaseLabel: PHASE_LABELS[finalState.phase],
    productNextAction: productNext,
    planVersion: revision.history.length + 1,
    policyMode: finalState.policySnapshot?.mode,
    taskTitle: firstLine(finalState.ticket?.text),
    forcedConvergence,
    proofSummary: projectPlanProofStatus(finalState),
    currentPlanDigest: revision.currentPlan.digest,
    reviewedDigest: reviewedIdentity?.reviewedDigest,
    reviewedObligationId: reviewedIdentity?.reviewedObligationId,
  };
  // Cards and artifacts are canonical Unicode; only host-visible Markdown uses preferences.
  const reviewCard = buildPlanReviewCard(reviewCardInput);
  const presentationMarkdown = buildPlanReviewCard(reviewCardInput, {
    glyphProfile: (await readConfig(scope.worktree)).presentation.opencode.glyphProfile,
  });
  const artifactErr = await materializeReviewCardArtifact(
    scope.sessDir,
    'plan-review-card',
    reviewCard,
    finalState,
    revision.currentPlan.digest,
  );
  const response: Record<string, unknown> = {
    phase: finalState.phase,
    status: forcedConvergence
      ? `Independent review reached the iteration limit (${iteration}/${scope.maxSelfReviewIterations}) without reviewer approval (last verdict: ${revision.verdict}). Your decision is required.`
      : `Independent review converged at iteration ${iteration}. Plan ready for approval.`,
    planDigest: revision.currentPlan.digest,
    selfReviewIteration: iteration,
    reviewCard,
    presentation: { markdown: presentationMarkdown },
    next: formatEval(ev),
    _audit: { transitions },
  };
  if (artifactErr) response.artifactWarning = artifactErr;
  return response;
}

export async function persistConvergedPlanReview(input: ConvergedPlanReviewInput): Promise<string> {
  const { scope, finalState } = input;
  await writeStateWithArtifacts(scope.sessDir, finalState);
  if (finalState.phase !== 'PLAN_REVIEW') {
    return appendNextAction(JSON.stringify(convergedPlanResponse(input)), finalState);
  }

  const response = await convergedPlanReviewCardResponse(input);
  return appendNextAction(JSON.stringify(response), finalState);
}

export async function persistNonConvergedPlanReview(
  scope: PlanExecutionScope,
  finalState: SessionState,
  transitions: unknown,
  revision: PlanRevisionResult,
  iteration: number,
): Promise<string> {
  const nextPlanVersion = revision.history.length + 1;
  const priorTargetPaths = findPriorPlanTargetPaths(finalState.reviewAssurance);
  const targetPaths = [
    ...new Set([...(priorTargetPaths ?? []), ...(scope.args.targetPaths ?? [])]),
  ];
  const classification = await resolvePreImplementationChallengeClassification(
    finalState,
    scope.wsDir,
    scope.reviewPolicy.subagentEnabled,
    targetPaths,
  );
  const resolvedTargetPaths =
    classification.kind === 'available'
      ? [...classification.changedFiles]
      : ([] as readonly string[]);
  const metadata: Record<string, unknown> = {};
  if (resolvedTargetPaths && resolvedTargetPaths.length > 0) {
    metadata.targetPaths = resolvedTargetPaths;
  }
  const mint = await mintPlanRevisionAttempt({
    scope,
    finalState,
    revision,
    iteration,
    nextPlanVersion,
    resolvedTargetPaths,
    metadata,
  });
  if (mint.kind === 'blocked') return mint.message;
  const attemptResult = mint.attemptResult;
  const nextObligation = attemptResult?.obligation ?? null;
  const stateToPersist = attemptResult
    ? { ...finalState, reviewAssurance: attemptResult.assurance }
    : finalState;
  await writeStateWithArtifacts(scope.sessDir, stateToPersist);
  return appendNextAction(
    JSON.stringify(
      nonConvergedPlanResponse(scope, finalState, transitions, revision, nextObligation),
    ),
    stateToPersist,
  );
}

/**
 * Mint the plan revision obligation with its first attempt. Plan revisions
 * freeze their repository context exactly like the initial submission: the
 * durable freeze record is MANDATORY for plan obligations, and a
 * repository-governed attempt is born with its host-owned Discovery snapshot
 * (persistence coherence).
 */
async function mintPlanRevisionAttempt(input: {
  scope: PlanExecutionScope;
  finalState: SessionState;
  revision: PlanRevisionResult;
  iteration: number;
  nextPlanVersion: number;
  resolvedTargetPaths: readonly string[];
  metadata: Record<string, unknown>;
}): Promise<
  | { kind: 'ok'; attemptResult: ReturnType<typeof createObligationAndAttempt> | null }
  | { kind: 'blocked'; message: string }
> {
  const { scope, finalState, revision, iteration, nextPlanVersion, resolvedTargetPaths, metadata } =
    input;
  const freeze = await freezeContextAuthorityAtHead(scope.wsDir);
  const authority = frozenAuthorityOrUndefined(freeze);
  const discovery = await resolveAttemptDiscoveryOrBlock({
    state: finalState,
    worktree: scope.wsDir,
    repositoryGoverned: authority !== undefined,
    now: scope.ctx.now(),
  });
  if (discovery.kind === 'blocked') {
    return {
      kind: 'blocked',
      message: formatBlocked('REVIEWER_CONTEXT_UNAVAILABLE', {
        reason: discovery.reason,
      }),
    };
  }
  const attemptResult = scope.reviewPolicy.subagentEnabled
    ? createObligationAndAttempt(
        finalState.reviewAssurance,
        {
          obligationType: 'plan',
          iteration,
          planVersion: nextPlanVersion,
          now: scope.ctx.now(),
          subjectDigest: revision.currentPlan.digest,
          // Frozen review material: the exact (possibly revised) plan artifact
          // plus originating ticket context, digest-bound at creation time.
          reviewMaterial: freezeReviewMaterial(
            buildFrozenReviewMaterialContent({
              obligationType: 'plan',
              state: finalState,
              artifact: revision.currentPlan.body,
            }),
            revision.currentPlan.digest,
          ),
          // The (possibly revised) plan artifact is the review SUBJECT; changedFiles
          // below stay challenge-classification and repository-evidence context only.
          reviewSubjectScope: artifactReviewSubjectScope(
            'plan',
            revision.currentPlan.body,
            revision.currentPlan.digest,
          ),
          reviewProfile: resolveFrozenReviewProfile(finalState.policySnapshot),
          profileSource: 'policy_default',
          policySnapshot: finalState.policySnapshot,
          changedFiles: resolvedTargetPaths,
          claimedTaskClass: finalState.claimedTaskClass,
          metadata,
          repositoryAuthority: authority,
          repositoryEvidenceFreeze: freezeOutcomeRecord(freeze),
        },
        scope.ctx.now(),
        discovery.context,
      )
    : null;
  return { kind: 'ok', attemptResult };
}

export function nonConvergedPlanResponse(
  scope: PlanExecutionScope,
  finalState: SessionState,
  transitions: unknown,
  revision: PlanRevisionResult,
  nextObligation: Parameters<typeof reviewObligationResponseFields>[0],
): Record<string, unknown> {
  const nextPlanVersion = revision.history.length + 1;
  const reviewInstruction = buildPlanReviewInstruction({
    scope,
    obligation: nextObligation,
    iteration: scope.state.selfReview!.iteration + 1,
    planVersion: nextPlanVersion,
    subjectLabel: 'revised plan text and ticket text',
    state: finalState,
  });
  return {
    phase: finalState.phase,
    status: `Independent review iteration ${scope.state.selfReview!.iteration + 1}/${scope.maxSelfReviewIterations}. Verdict: ${revision.verdict}.`,
    planDigest: revision.currentPlan.digest,
    selfReviewIteration: scope.state.selfReview!.iteration + 1,
    revisionDelta: revision.revisionDelta,
    reviewMode: 'subagent',
    ...reviewObligationResponseFields(nextObligation),
    next: reviewInstruction.next,
    reviewInvocation: reviewInstruction.reviewInvocation,
    _audit: { transitions },
  };
}

export async function persistPlanReview(
  scope: PlanExecutionScope,
  revision: PlanRevisionResult,
  effectiveFindings: ReviewFindings | null,
  consumedAssurance: ReturnType<typeof import('../review/assurance.js').consumeReviewObligation>,
  buildReviewedPlanState: (
    scope: PlanExecutionScope,
    revision: PlanRevisionResult,
    effectiveFindings: ReviewFindings | null,
    consumedAssurance: ReturnType<typeof import('../review/assurance.js').consumeReviewObligation>,
  ) => SessionState,
): Promise<string> {
  const nextState = buildReviewedPlanState(scope, revision, effectiveFindings, consumedAssurance);
  const evalFn = (s: SessionState) => evaluate(s, scope.policy);
  const advanced = autoAdvance(nextState, evalFn, scope.ctx);
  // #428: fail closed on overflow BEFORE persisting — no partially-advanced write.
  if (advanced.kind === 'overflow') {
    return formatAutoAdvanceOverflow(advanced);
  }
  const { state: finalState, evalResult: ev, transitions } = advanced;
  const iteration = scope.state.selfReview!.iteration + 1;
  const approvedConverged = revision.revisionDelta === 'none' && revision.verdict === 'accept';
  const maxReached = iteration >= scope.maxSelfReviewIterations;

  // Force-convergence: the review loop exhausted its iteration budget without
  // an approving verdict. Parity with the implementation-review flow
  // (implement.ts handleApprovedReview): NEVER block here. Route through the
  // converged path so human-gated modes stop at PLAN_REVIEW for the human to
  // decide, and auto-approve modes continue with an honest, audit-visible
  // status. The previous hard block stranded the session at PLAN_REVIEW while
  // its recovery told the user to run /plan — which is inadmissible at that
  // phase — leaving the flow wedged.
  const forcedConvergence = maxReached && !approvedConverged;

  if (forcedConvergence) {
    getAdapterLogger().warn(
      'flowguard_plan',
      'Plan review force-converged at iteration limit without reviewer approval',
      {
        sessionId: scope.context.sessionID,
        iteration,
        maxIterations: scope.maxSelfReviewIterations,
        lastVerdict: revision.verdict,
        phase: finalState.phase,
        planDigest: revision.currentPlan.digest,
      },
    );
  }

  if (approvedConverged || forcedConvergence) {
    return persistConvergedPlanReview({
      scope,
      finalState,
      ev,
      transitions,
      revision,
      iteration,
      forcedConvergence,
    });
  }
  return persistNonConvergedPlanReview(scope, finalState, transitions, revision, iteration);
}
