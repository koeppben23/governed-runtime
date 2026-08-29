/**
 * @module integration/tools/architecture-restart
 * @description Architecture Mode-A routing for existing review obligations:
 *              output-repair reissue, attempt re-emission, and review
 *              orchestration restart/revision after a blocked obligation.
 *
 * `/architecture` re-invocation is the authorized trigger for review
 * lifecycle transitions of the latest architecture obligation:
 *
 *   pending + bindable attempt      → re-emit the review instruction
 *   pending + repairable rejection  → mint a fresh attempt on the SAME
 *                                     obligation (canonical output repair)
 *   blocked + same ADR digest       → fresh review orchestration for the SAME
 *                                     ADR identity/revision (ADR id, createdAt,
 *                                     nextAdrNumber unchanged; new obligation +
 *                                     attempt + prompt generation)
 *   blocked + different ADR digest  → ADR revision (same id, new digest, fresh
 *                                     obligation bound to the new digest; the
 *                                     blocked predecessor stays bound to the
 *                                     old digest)
 *
 * `executeArchitecture` is a creation rail and is NEVER reused here: a review
 * orchestration restart must not mint a new ADR identity.
 *
 * @version v1
 */

import { readState } from '../../adapters/persistence.js';
import { validateAdrSections } from '../../state/evidence.js';
import type { ReviewObligation } from '../../state/evidence.js';
import { normalizeArchitectureClaims } from '../../state/proofgraph-approval.js';
import type { SessionState } from '../../state/schema.js';
import {
  appendObligationWithAttempt,
  artifactReviewSubjectScope,
  createReviewObligation,
  freezeReviewMaterial,
  reviewObligationResponseFields,
  resolveFrozenReviewProfile,
} from '../review/assurance.js';
import {
  resolveReviewContinuation,
  type ReviewContinuation,
} from '../review/review-continuation.js';
import { blockObligation } from '../review/obligation-state.js';
import { reissueReviewAttempt } from './review-tool/continuation.js';
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
import {
  buildArchitectureReviewInstruction,
  type ArchitectureArgs,
  type ArchitectureSession,
} from './architecture-shared.js';
import { appendNextAction, formatBlocked, writeStateWithArtifacts } from './helpers.js';

// eslint-disable-next-line complexity -- the architecture continuation route is one sequential fail-closed chain (pending reissue, output repair, restart, missing-attempt close).
export async function routeArchitectureInitialSubmission(
  args: ArchitectureArgs,
  session: ArchitectureSession,
): Promise<string | null> {
  const { state, policy } = session;
  if (state.phase !== 'ARCHITECTURE' || !state.architecture || !state.selfReview) return null;

  const subagentEnabled = policy.selfReview?.subagentEnabled ?? false;
  const continuation = resolveReviewContinuation(state.reviewAssurance, 'architecture');

  switch (continuation.kind) {
    case 'awaiting_task':
    case 'output_repair':
      return routePendingArchitectureContinuation(args, session, continuation);
    case 'integrity_blocked':
      return formatBlocked(continuation.code, {
        obligationId: continuation.obligation.obligationId,
        reason: continuation.reason,
      });
    case 'missing_attempt':
      return routeArchitectureMissingAttempt(session, continuation.obligation, continuation.code);
    case 'blocked':
      return restartArchitectureReview(args, session, subagentEnabled, continuation.obligation);
    case 'awaiting_verdict':
    case 'none':
      return null;
  }
}

async function routeArchitectureMissingAttempt(
  session: ArchitectureSession,
  obligation: NonNullable<ArchitectureSession['state']['reviewAssurance']>['obligations'][number],
  code: string,
): Promise<string> {
  const blockedState = blockObligation(session.state, obligation.obligationId, code);
  await writeStateWithArtifacts(session.sessDir, blockedState);
  return formatBlocked(code, {
    obligationId: obligation.obligationId,
    recovery:
      'The broken architecture review obligation has been deterministically closed. Re-run /architecture to submit a fresh revision and mint a new review obligation.',
  });
}

async function routePendingArchitectureContinuation(
  args: ArchitectureArgs,
  session: ArchitectureSession,
  continuation: Extract<ReviewContinuation, { readonly kind: 'awaiting_task' | 'output_repair' }>,
): Promise<string> {
  // A pending continuation reviews the FROZEN subject: a submitted artifact
  // with a different digest must never be silently ignored (or trigger a
  // repair of the old subject) — fail closed instead.
  const changed = changedSubjectWhilePending(args, continuation.obligation, session);
  if (changed) return changed;
  if (continuation.kind === 'awaiting_task') {
    return architectureInstructionResponse(session, {
      obligation: continuation.obligation,
      attemptId: continuation.attemptId,
      status: 'Architecture review is pending.',
      iteration: continuation.obligation.iteration,
      planVersion: continuation.obligation.planVersion,
    });
  }
  return routeArchitectureOutputRepair(session, continuation.obligation);
}

function changedSubjectWhilePending(
  args: ArchitectureArgs,
  obligation: ReviewObligation,
  session: ArchitectureSession,
): string | null {
  if (!args.adrText || !args.adrText.trim()) return null;
  const submittedDigest = session.ctx.digest(args.adrText);
  if (submittedDigest === obligation.subjectDigest) return null;
  return formatBlocked('REVIEW_SUBJECT_CHANGED_WHILE_PENDING', {
    obligationId: obligation.obligationId,
    subjectDigest: obligation.subjectDigest,
    submittedDigest,
  });
}

async function routeArchitectureOutputRepair(
  session: ArchitectureSession,
  obligation: ReviewObligation,
): Promise<string> {
  const reissue = await reissueReviewAttempt(
    session.sessDir,
    session.state,
    obligation,
    session.ctx.now(),
  );
  if (reissue.kind === 'blocked') {
    return formatBlocked(reissue.code, {
      obligationId: obligation.obligationId,
      reason: reissue.reason,
    });
  }
  const fresh = (await readState(session.sessDir)) ?? session.state;
  return architectureInstructionResponse(
    { ...session, state: fresh },
    {
      obligation,
      attemptId: reissue.attempt.attemptId,
      status: 'Architecture review repair attempt issued.',
      iteration: obligation.iteration,
      planVersion: obligation.planVersion,
    },
  );
}

function architectureInstructionResponse(
  session: ArchitectureSession,
  input: {
    obligation: ReviewObligation;
    attemptId: string | null;
    status: string;
    iteration: number;
    planVersion: number;
  },
): string {
  const { state, policy } = session;
  const subagentEnabled = policy.selfReview?.subagentEnabled ?? false;
  const instruction = buildArchitectureReviewInstruction({
    policy,
    subagentEnabled,
    obligation: input.obligation,
    iteration: input.iteration,
    planVersion: input.planVersion,
    subjectLabel: 'full ADR text, ADR title, and ticket text',
    state,
  });
  const response: Record<string, unknown> = {
    phase: state.phase,
    status: input.status,
    adrId: state.architecture!.id,
    adrDigest: state.architecture!.digest,
    selfReviewIteration: state.selfReview?.iteration ?? 0,
    reviewMode: subagentEnabled ? 'subagent' : 'self',
    ...reviewObligationResponseFields(input.obligation, input.attemptId),
    // Durable degradation: re-emits and repairs render the persisted freeze
    // cause, not only the immediate Mode-A response.
    ...repositoryEvidenceUnavailableField(input.obligation.repositoryEvidenceFreeze),
    next: instruction.next,
    ...(instruction.reviewInvocation ? { reviewInvocation: instruction.reviewInvocation } : {}),
    _audit: { transitions: [] },
  };
  return appendNextAction(JSON.stringify(response), state);
}

function restartBlockedCount(state: SessionState): number {
  return (state.reviewAssurance?.obligations ?? []).filter(
    (o) => o.obligationType === 'architecture' && o.status === 'blocked',
  ).length;
}

async function mintRestartObligation(
  args: ArchitectureArgs,
  session: ArchitectureSession,
  subagentEnabled: boolean,
  nextAdr: NonNullable<SessionState['architecture']>,
  cycle: { readonly now: string; readonly iteration: number; readonly planVersion: number },
): Promise<ReturnType<typeof createReviewObligation> | null> {
  if (!subagentEnabled) return null;
  const classification = await resolvePreImplementationChallengeClassification(
    session.state,
    session.wsDir,
    subagentEnabled,
    args.targetPaths,
  );
  const resolvedTargetPaths =
    classification.kind === 'available' ? [...classification.changedFiles] : undefined;
  const metadata: Record<string, unknown> = {};
  if (resolvedTargetPaths && resolvedTargetPaths.length > 0) {
    metadata.targetPaths = resolvedTargetPaths;
  }
  const freeze = await freezeContextAuthorityAtHead(session.wsDir);
  return createReviewObligation({
    obligationType: 'architecture',
    iteration: cycle.iteration,
    planVersion: cycle.planVersion,
    now: cycle.now,
    subjectDigest: nextAdr.digest,
    // Frozen review material: the exact ADR artifact plus originating
    // ticket context, canonicalized and digest-bound at creation time.
    reviewMaterial: freezeReviewMaterial(
      buildFrozenReviewMaterialContent({
        obligationType: 'architecture',
        state: { ...session.state, architecture: nextAdr },
        artifact: nextAdr.adrText,
      }),
      nextAdr.digest,
    ),
    reviewSubjectScope: artifactReviewSubjectScope('adr', nextAdr.adrText, nextAdr.digest),
    reviewProfile: resolveFrozenReviewProfile(session.state.policySnapshot),
    profileSource: 'policy_default',
    policySnapshot: session.state.policySnapshot,
    changedFiles: resolvedTargetPaths,
    claimedTaskClass: session.state.claimedTaskClass,
    metadata,
    repositoryAuthority: frozenAuthorityOrUndefined(freeze),
    // Durable freeze outcome: continuations, restarts, and re-emits render
    // the exact degradation cause from persisted state.
    repositoryEvidenceFreeze: freezeOutcomeRecord(freeze),
  });
}

async function restartArchitectureReview(
  args: ArchitectureArgs,
  session: ArchitectureSession,
  subagentEnabled: boolean,
  predecessor: ReviewObligation,
): Promise<string | null> {
  const { state } = session;
  if (!state.architecture || !state.selfReview) return null;
  if (!args.adrText || !args.adrText.trim()) {
    // Handled by the regular Mode A path (EMPTY_ADR_TEXT) — the ADR is never
    // recreated because the empty-text block fires before executeArchitecture.
    return null;
  }
  // Cycle-binding consistency: the fresh review generation continues the
  // current review cycle — the blocked predecessor, the flow state, and the
  // fresh obligation must all carry the same iteration.
  if (predecessor.iteration !== state.selfReview.iteration) {
    return formatBlocked('RESTART_CYCLE_ITERATION_MISMATCH', {
      obligationId: predecessor.obligationId,
      predecessorIteration: String(predecessor.iteration),
      selfReviewIteration: String(state.selfReview.iteration),
    });
  }
  const blockedCount = restartBlockedCount(state);
  if (blockedCount >= 3) {
    return formatBlocked('ORCHESTRATION_PERMANENTLY_FAILED', {
      attempts: String(blockedCount),
    });
  }

  const now = session.ctx.now();
  const submittedDigest = session.ctx.digest(args.adrText);
  const sameRevision = submittedDigest === state.architecture.digest;

  const revision = resolveRestartRevision(args, state, submittedDigest, sameRevision);
  if (revision.kind === 'blocked') return revision.blocked;
  const nextAdr = revision.nextAdr;

  const iteration = state.selfReview.iteration;
  const planVersion = predecessor.planVersion;
  const mintResult = await mintRestartObligationWithAttempt(
    args,
    session,
    subagentEnabled,
    nextAdr,
    {
      now,
      iteration,
      planVersion,
    },
  );
  if (mintResult.kind === 'blocked') return mintResult.message;
  const obligation = mintResult.obligation;
  const restartAttemptId = mintResult.attemptId;
  const augmentedState = buildRestartedState(state, {
    nextAdr,
    sameRevision,
    revisionDelta: revision.revisionDelta,
    obligation,
    assurance: mintResult.assurance,
  });
  await writeStateWithArtifacts(session.sessDir, augmentedState);

  const instruction = buildArchitectureReviewInstruction({
    policy: session.policy,
    subagentEnabled,
    obligation,
    iteration,
    planVersion,
    subjectLabel: 'full ADR text, ADR title, and ticket text',
    state: augmentedState,
  });
  return appendNextAction(
    JSON.stringify(
      buildRestartResponse(augmentedState, {
        nextAdr,
        sameRevision,
        revisionDelta: revision.revisionDelta,
        subagentEnabled,
        obligation,
        restartAttemptId,
        instruction,
      }),
    ),
    augmentedState,
  );
}

/**
 * Mint the fresh restart obligation together with its first attempt. The
 * attempt is born WITH its host-owned Discovery snapshot when the obligation
 * is repository-governed (persistence coherence); a structural projection
 * failure blocks the restart before any state mutation.
 */
async function mintRestartObligationWithAttempt(
  args: ArchitectureArgs,
  session: ArchitectureSession,
  subagentEnabled: boolean,
  nextAdr: NonNullable<SessionState['architecture']>,
  cycle: { readonly now: string; readonly iteration: number; readonly planVersion: number },
): Promise<
  | {
      kind: 'ok';
      obligation: ReturnType<typeof createReviewObligation> | null;
      attemptId: string | null;
      assurance: SessionState['reviewAssurance'];
    }
  | { kind: 'blocked'; message: string }
> {
  const minted = await mintRestartObligation(args, session, subagentEnabled, nextAdr, cycle);
  const obligation = minted;
  if (!obligation) {
    return {
      kind: 'ok',
      obligation: null,
      attemptId: null,
      assurance: session.state.reviewAssurance,
    };
  }
  const discovery = await resolveAttemptDiscoveryOrBlock({
    state: session.state,
    worktree: session.worktree,
    repositoryGoverned: hasFrozenRepositoryAuthority(obligation),
    now: cycle.now,
    obligationId: obligation.obligationId,
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
  const withAttempt = appendObligationWithAttempt(
    session.state.reviewAssurance,
    obligation,
    cycle.now,
    discovery.context,
  );
  return {
    kind: 'ok',
    obligation,
    attemptId: withAttempt.attemptId,
    assurance: withAttempt.assurance,
  };
}

function buildRestartResponse(
  augmentedState: SessionState,
  input: {
    nextAdr: NonNullable<SessionState['architecture']>;
    sameRevision: boolean;
    revisionDelta: 'none' | 'minor';
    subagentEnabled: boolean;
    obligation: ReturnType<typeof createReviewObligation> | null;
    restartAttemptId: string | null;
    instruction: ReturnType<typeof buildArchitectureReviewInstruction>;
  },
): Record<string, unknown> {
  return {
    phase: augmentedState.phase,
    status: input.sameRevision
      ? `ADR ${input.nextAdr.id} review orchestration restarted (same revision).`
      : `ADR ${input.nextAdr.id} revised after blocked review; fresh review orchestration started.`,
    adrId: input.nextAdr.id,
    adrDigest: input.nextAdr.digest,
    selfReviewIteration: augmentedState.selfReview!.iteration,
    revisionDelta: input.revisionDelta,
    reviewMode: input.subagentEnabled ? 'subagent' : 'self',
    ...reviewObligationResponseFields(input.obligation, input.restartAttemptId),
    ...repositoryEvidenceUnavailableField(input.obligation?.repositoryEvidenceFreeze),
    next: input.instruction.next,
    ...(input.instruction.reviewInvocation
      ? { reviewInvocation: input.instruction.reviewInvocation }
      : {}),
    _audit: { transitions: [] },
  };
}

function buildRestartedState(
  state: SessionState,
  input: {
    nextAdr: NonNullable<SessionState['architecture']>;
    sameRevision: boolean;
    revisionDelta: 'none' | 'minor';
    obligation: ReturnType<typeof createReviewObligation> | null;
    assurance: SessionState['reviewAssurance'];
  },
): SessionState {
  // ADR identity, createdAt, and nextAdrNumber are NEVER mutated here:
  // a blocked review obligation is a new review generation, not a new ADR.
  return {
    ...state,
    architecture: input.nextAdr,
    selfReview: {
      ...state.selfReview!,
      prevDigest: input.sameRevision ? state.selfReview!.prevDigest : state.architecture!.digest,
      currDigest: input.nextAdr.digest,
      revisionDelta: input.sameRevision ? state.selfReview!.revisionDelta : input.revisionDelta,
      verdict: 'changes_requested',
    },
    reviewAssurance: input.assurance,
  };
}

function resolveRestartRevision(
  args: ArchitectureArgs,
  state: SessionState,
  submittedDigest: string,
  sameRevision: boolean,
):
  | { readonly kind: 'blocked'; readonly blocked: string }
  | {
      readonly kind: 'ok';
      readonly nextAdr: NonNullable<SessionState['architecture']>;
      readonly revisionDelta: 'none' | 'minor';
    } {
  if (sameRevision) {
    return { kind: 'ok', nextAdr: state.architecture!, revisionDelta: 'none' };
  }
  const missingSections = validateAdrSections(args.adrText!);
  if (missingSections.length > 0) {
    return {
      kind: 'blocked',
      blocked: formatBlocked('MISSING_ADR_SECTIONS', {
        sections: missingSections.join(', '),
      }),
    };
  }
  return {
    kind: 'ok',
    nextAdr: {
      ...state.architecture!,
      adrText: args.adrText!,
      digest: submittedDigest,
      ...(args.claims
        ? {
            claimDeclarations: {
              flow: 'architecture' as const,
              claims: normalizeArchitectureClaims(args.claims)!,
            },
          }
        : {}),
      // A revision invalidates any prior approval over the old digest.
      approvalCertificate: undefined,
    },
    revisionDelta: 'minor',
  };
}
