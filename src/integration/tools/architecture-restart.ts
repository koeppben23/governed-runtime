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
import { resolveReviewContinuation } from '../review/review-continuation.js';
import { reissueReviewAttempt } from './review-tool/continuation.js';
import { resolvePreImplementationChallengeClassification } from './pre-implementation-challenge.js';
import { freezeContextAuthorityAtHead } from '../../rails/repository-authority.js';
import { buildFrozenReviewMaterialContent } from '../review/reviewer-context.js';
import {
  buildArchitectureReviewInstruction,
  type ArchitectureArgs,
  type ArchitectureSession,
} from './architecture-shared.js';
import { appendNextAction, formatBlocked, writeStateWithArtifacts } from './helpers.js';

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
      return architectureInstructionResponse(session, {
        obligation: continuation.obligation,
        attemptId: continuation.attemptId,
        status: 'Architecture review is pending.',
        iteration: continuation.obligation.iteration,
        planVersion: continuation.obligation.planVersion,
      });
    case 'output_repair':
      return routeArchitectureOutputRepair(session, continuation.obligation);
    case 'blocked':
      return restartArchitectureReview(args, session, subagentEnabled);
    case 'awaiting_verdict':
    case 'none':
      return null;
  }
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
  now: string,
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
  const repositoryAuthority = await freezeContextAuthorityAtHead(session.wsDir);
  return createReviewObligation({
    obligationType: 'architecture',
    iteration: 0,
    planVersion: 1,
    now,
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
    repositoryAuthority,
  });
}

async function restartArchitectureReview(
  args: ArchitectureArgs,
  session: ArchitectureSession,
  subagentEnabled: boolean,
): Promise<string | null> {
  const { state } = session;
  if (!state.architecture || !state.selfReview) return null;
  if (!args.adrText || !args.adrText.trim()) {
    // Handled by the regular Mode A path (EMPTY_ADR_TEXT) — the ADR is never
    // recreated because the empty-text block fires before executeArchitecture.
    return null;
  }
  if (restartBlockedCount(state) >= 3) {
    return formatBlocked('ORCHESTRATION_PERMANENTLY_FAILED', {
      attempts: String(restartBlockedCount(state)),
    });
  }

  const now = session.ctx.now();
  const submittedDigest = session.ctx.digest(args.adrText);
  const sameRevision = submittedDigest === state.architecture.digest;

  const revision = resolveRestartRevision(args, state, submittedDigest, sameRevision);
  if (revision.kind === 'blocked') return revision.blocked;
  const nextAdr = revision.nextAdr;

  const obligation = await mintRestartObligation(args, session, subagentEnabled, nextAdr, now);
  const augmentedState = buildRestartedState(state, {
    nextAdr,
    sameRevision,
    revisionDelta: revision.revisionDelta,
    obligation,
    now,
  });
  const augmentedSelfReview = augmentedState.selfReview!;
  await writeStateWithArtifacts(session.sessDir, augmentedState);

  const instruction = buildArchitectureReviewInstruction({
    policy: session.policy,
    subagentEnabled,
    obligation,
    iteration: 0,
    planVersion: 1,
    subjectLabel: 'full ADR text, ADR title, and ticket text',
    state: augmentedState,
  });
  const response: Record<string, unknown> = {
    phase: augmentedState.phase,
    status: sameRevision
      ? `ADR ${nextAdr.id} review orchestration restarted (same revision).`
      : `ADR ${nextAdr.id} revised after blocked review; fresh review orchestration started.`,
    adrId: nextAdr.id,
    adrDigest: nextAdr.digest,
    selfReviewIteration: augmentedSelfReview.iteration,
    revisionDelta: revision.revisionDelta,
    reviewMode: subagentEnabled ? 'subagent' : 'self',
    ...reviewObligationResponseFields(obligation, null),
    next: instruction.next,
    ...(instruction.reviewInvocation ? { reviewInvocation: instruction.reviewInvocation } : {}),
    _audit: { transitions: [] },
  };
  return appendNextAction(JSON.stringify(response), augmentedState);
}

function buildRestartedState(
  state: SessionState,
  input: {
    nextAdr: NonNullable<SessionState['architecture']>;
    sameRevision: boolean;
    revisionDelta: 'none' | 'minor';
    obligation: ReturnType<typeof createReviewObligation> | null;
    now: string;
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
    reviewAssurance: input.obligation
      ? appendObligationWithAttempt(state.reviewAssurance, input.obligation, input.now).assurance
      : state.reviewAssurance,
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
