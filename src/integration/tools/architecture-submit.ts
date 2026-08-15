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
  freezeReviewMaterial,
  reviewObligationResponseFields,
  resolveFrozenReviewProfile,
} from '../review/assurance.js';
import { resolvePreImplementationChallengeClassification } from './pre-implementation-challenge.js';
import {
  freezeContextAuthorityAtHead,
  freezeOutcomeRecord,
  frozenAuthorityOrUndefined,
} from '../../rails/repository-authority.js';
import { resolveAttemptDiscoveryOrBlock } from '../review/discovery-attempt-context.js';
import { repositoryEvidenceUnavailableField } from '../review/observation-access.js';
import { hasFrozenRepositoryAuthority } from '../../state/evidence.js';
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

async function classifyAndCreateArchObligation(ctx: ArchObligationContext): Promise<
  | {
      kind: 'ok';
      state: SessionState;
      obligation: ReturnType<typeof createReviewObligation> | null;
      attemptId: string | null;
    }
  | { kind: 'blocked'; message: string }
> {
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
  const minted = await mintArchSubmissionObligation(ctx, resolvedTargetPaths, metadata);
  // Repository-governed attempts are minted WITH their host-owned Discovery
  // snapshot (persistence coherence). A structural projection failure blocks
  // before any state mutation, mirroring the standalone review path.
  const repositoryGoverned = minted ? hasFrozenRepositoryAuthority(minted) : false;
  const discovery = await resolveAttemptDiscoveryOrBlock({
    state: ctx.state,
    worktree: ctx.wsDir,
    repositoryGoverned,
    now: ctx.now,
    ...(minted ? { obligationId: minted.obligationId } : {}),
  });
  if (discovery.kind === 'blocked') {
    return {
      kind: 'blocked',
      message: formatBlocked('REVIEWER_CONTEXT_UNAVAILABLE', {
        ...(discovery.obligationId ? { obligationId: discovery.obligationId } : {}),
        reason: discovery.reason,
      }),
    };
  }
  let archAttemptId: string | null = null;
  const augmentedState = minted
    ? (() => {
        const withAttempt = appendObligationWithAttempt(
          ctx.state.reviewAssurance,
          minted,
          ctx.now,
          discovery.context,
        );
        archAttemptId = withAttempt.attemptId;
        return {
          ...ctx.state,
          reviewAssurance: withAttempt.assurance,
        };
      })()
    : ctx.state;
  return {
    kind: 'ok',
    state: augmentedState,
    obligation: minted,
    attemptId: archAttemptId,
  };
}

async function mintArchSubmissionObligation(
  ctx: ArchObligationContext,
  resolvedTargetPaths: readonly string[] | undefined,
  metadata: Record<string, unknown>,
): Promise<ReturnType<typeof createReviewObligation> | null> {
  if (!ctx.subagentEnabled) return null;
  const digest = ctx.state.architecture?.digest ?? `arch-submit-${ctx.archPlanVersion}`;
  const adrText = ctx.state.architecture?.adrText ?? '';
  const freeze = await freezeContextAuthorityAtHead(ctx.wsDir);
  return createReviewObligation({
    obligationType: 'architecture',
    iteration: 0,
    planVersion: ctx.archPlanVersion,
    now: ctx.now,
    subjectDigest: digest,
    // Frozen review material: the exact ADR artifact plus originating
    // ticket context, canonicalized and digest-bound at creation time.
    reviewMaterial: freezeReviewMaterial(
      buildFrozenReviewMaterialContent({
        obligationType: 'architecture',
        state: ctx.state,
        artifact: adrText,
      }),
      digest,
    ),
    // The ADR artifact is the review SUBJECT; changedFiles below stay
    // challenge-classification and repository-evidence context only.
    reviewSubjectScope: artifactReviewSubjectScope('adr', adrText, digest),
    reviewProfile: resolveFrozenReviewProfile(ctx.policySnapshot),
    profileSource: 'policy_default',
    policySnapshot: ctx.policySnapshot,
    changedFiles: resolvedTargetPaths,
    claimedTaskClass: ctx.state.claimedTaskClass,
    metadata,
    // Frozen repository context (freeze-time resolution): architecture
    // reviews may cite repository evidence only against this context.
    repositoryAuthority: frozenAuthorityOrUndefined(freeze),
    // Durable freeze outcome: continuations, restarts, and re-emits render
    // the exact degradation cause from persisted state.
    repositoryEvidenceFreeze: freezeOutcomeRecord(freeze),
  });
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
  if (classification.kind === 'blocked') return classification.message;
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
    ...repositoryEvidenceUnavailableField(nextObligation?.repositoryEvidenceFreeze),
    next: instruction.next,
    ...(instruction.reviewInvocation ? { reviewInvocation: instruction.reviewInvocation } : {}),
    _audit: { transitions: result.transitions },
  };

  return appendNextAction(JSON.stringify(modeAResponse), augmentedState);
}
