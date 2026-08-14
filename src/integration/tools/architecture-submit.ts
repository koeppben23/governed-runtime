/**
 * @module integration/tools/architecture-submit
 * @description Mode A — ADR submission flow.
 *
 * @version v1
 */

import type { ArchitectureArgs, ArchitectureSession } from './architecture-shared.js';
import { buildArchitectureReviewInstruction } from './architecture-shared.js';
import { formatBlocked, appendNextAction, writeStateWithArtifacts } from './helpers.js';
import type { SessionState } from '../../state/schema.js';
import { executeArchitecture } from '../../rails/architecture.js';
import { normalizeArchitectureClaims } from '../../state/proofgraph-approval.js';
import {
  appendObligationWithAttempt,
  artifactReviewSubjectScope,
  createReviewObligation,
  reviewObligationResponseFields,
  resolveFrozenReviewProfile,
  freezeReviewMaterial,
} from '../review/assurance.js';
import { resolvePreImplementationChallengeClassification } from './pre-implementation-challenge.js';
import { freezeContextAuthorityAtHead } from '../../rails/repository-authority.js';
import { buildFrozenReviewMaterialContent } from '../review/reviewer-context.js';

// ═══════════════════════════════════════════════════════════════════════════
// Mode A: ADR Submission
// ═══════════════════════════════════════════════════════════════════════════

interface ArchObligationContext {
  readonly state: SessionState;
  readonly wsDir: string;
  readonly subagentEnabled: boolean;
  readonly targetPaths: string[] | undefined;
  readonly archPlanVersion: number;
  readonly now: string;
  readonly policySnapshot: NonNullable<SessionState['policySnapshot']>;
}

async function classifyAndCreateArchObligation(ctx: ArchObligationContext): Promise<{
  state: SessionState;
  obligation: ReturnType<typeof createReviewObligation> | null;
  attemptId: string | null;
}> {
  const classification = await resolvePreImplementationChallengeClassification(
    ctx.state,
    ctx.wsDir,
    ctx.subagentEnabled,
    ctx.targetPaths,
  );
  const resolvedTargetPaths =
    classification.kind === 'available' ? [...classification.changedFiles] : undefined;
  const metadata: Record<string, unknown> = {};
  if (resolvedTargetPaths && resolvedTargetPaths.length > 0) {
    metadata.targetPaths = resolvedTargetPaths;
  }
  const repositoryAuthority = await freezeContextAuthorityAtHead(ctx.wsDir);
  const obligation = ctx.subagentEnabled
    ? createReviewObligation({
        obligationType: 'architecture',
        iteration: 0,
        planVersion: ctx.archPlanVersion,
        now: ctx.now,
        subjectDigest: ctx.state.architecture?.digest ?? `arch-submit-${ctx.archPlanVersion}`,
        reviewMaterial: freezeReviewMaterial(
          buildFrozenReviewMaterialContent({
            obligationType: 'architecture',
            state: ctx.state,
            artifact: ctx.state.architecture?.adrText ?? '',
          }),
          ctx.state.architecture?.digest ?? `arch-submit-${ctx.archPlanVersion}`,
        ),
        // The ADR artifact is the review SUBJECT; changedFiles below stay
        // challenge-classification and repository-evidence context only.
        reviewSubjectScope: artifactReviewSubjectScope(
          'adr',
          ctx.state.architecture?.adrText ?? '',
          ctx.state.architecture?.digest ?? `arch-submit-${ctx.archPlanVersion}`,
        ),
        reviewProfile: resolveFrozenReviewProfile(ctx.policySnapshot),
        profileSource: 'policy_default',
        policySnapshot: ctx.policySnapshot,
        changedFiles: resolvedTargetPaths,
        claimedTaskClass: ctx.state.claimedTaskClass,
        metadata,
        // Frozen repository context (freeze-time resolution): architecture
        // reviews may cite repository evidence only against this context.
        repositoryAuthority,
      })
    : null;
  let archAttemptId: string | null = null;
  const augmentedState = obligation
    ? (() => {
        const withAttempt = appendObligationWithAttempt(
          ctx.state.reviewAssurance,
          obligation,
          ctx.now,
        );
        archAttemptId = withAttempt.attemptId;
        return {
          ...ctx.state,
          reviewAssurance: withAttempt.assurance,
        };
      })()
    : ctx.state;
  return { state: augmentedState, obligation, attemptId: archAttemptId };
}

export async function handleAdrSubmission(
  args: ArchitectureArgs,
  session: ArchitectureSession,
): Promise<string> {
  const { sessDir, state, policy, ctx } = session;
  if (!args.title) return formatBlocked('EMPTY_ADR_TITLE');
  if (!args.adrText) return formatBlocked('EMPTY_ADR_TEXT');

  const claims = normalizeArchitectureClaims(args.claims);
  const result = executeArchitecture(
    state,
    { title: args.title, adrText: args.adrText, claims },
    ctx,
  );

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
  const now = ctx.now();
  const classification = await classifyAndCreateArchObligation({
    state: result.state,
    wsDir: session.wsDir,
    subagentEnabled,
    targetPaths: args.targetPaths,
    archPlanVersion,
    now,
    policySnapshot: result.state.policySnapshot,
  });
  const {
    state: augmentedState,
    obligation: nextObligation,
    attemptId: subAttemptId,
  } = classification;

  const persisted = await writeStateWithArtifacts(sessDir, augmentedState);

  const instruction = buildArchitectureReviewInstruction({
    policy: session.policy,
    subagentEnabled,
    obligation: nextObligation,
    iteration: 0,
    planVersion: archPlanVersion,
    subjectLabel: 'full ADR text, ADR title, and ticket text',
    state: persisted,
  });
  const modeAResponse: Record<string, unknown> = {
    phase: augmentedState.phase,
    status: `ADR ${augmentedState.architecture!.id} submitted: ${args.title}`,
    adrId: augmentedState.architecture!.id,
    adrDigest: augmentedState.architecture!.digest,
    selfReviewIteration: 0,
    maxSelfReviewIterations: policy.maxSelfReviewIterations,
    reviewMode: subagentEnabled ? 'subagent' : 'self',
    ...reviewObligationResponseFields(nextObligation, subAttemptId),
    next: instruction.next,
    ...(instruction.reviewInvocation ? { reviewInvocation: instruction.reviewInvocation } : {}),
    _audit: { transitions: result.transitions },
  };

  return appendNextAction(JSON.stringify(modeAResponse), augmentedState);
}
