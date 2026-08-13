/**
 * @module integration/tools/review-tool/obligation-creation
 * @description Creation and re-invocation of standalone review obligations.
 *
 * Owns how a content-aware /review call becomes a durable obligation with a
 * bindable attempt, including the repair path that re-arms an attempt for an
 * obligation that is still pending. Extracted from obligation.ts along the
 * obligation-creation boundary; obligation.ts re-exports this surface.
 *
 * @version v1
 */

import type { SessionState } from '../../../state/schema.js';
import { hasFrozenRepositoryAuthority } from '../../../state/evidence.js';
import type { ReviewObligation } from '../../../state/evidence.js';
import type {
  ReviewAssuranceState,
  ReviewMaterial,
  ReviewSubjectScope,
} from '../../../state/evidence-review.js';
import type { PreparedReviewContent } from '../../../rails/review.js';
import {
  createReviewObligation,
  appendObligationWithAttempt,
  resolveFrozenReviewProfile,
  findLatestPendingReviewObligation,
  createAttemptForExistingObligation,
} from '../../review/assurance.js';
import { authorizeOutputRepairReissue } from '../../review/reissue-authority.js';
import { blockObligation } from '../../review/obligation-state.js';
import { resolveReviewAttemptDiscoveryContext } from '../../review/discovery-attempt-context.js';
import type { ReviewAttemptDiscoveryContext } from '../../../state/evidence.js';
import { fingerprintReviewInput } from './fingerprint.js';
import { formatMissingContentAnalysis } from './obligation-format.js';
import { hasReviewContentInput, validateReviewContentSource } from './review-input.js';
import { formatBlocked, writeStateWithArtifacts } from '../helpers.js';
import { resolveChallengeClassificationEvidence } from '../review-obligation-classification.js';
import { type ResolvedBranchReviewSource } from '../../../adapters/gh-cli.js';
import type { ReviewToolArgs } from './types.js';

/**
 * Persist a new obligation together with its attempt.
 *
 * Returns the assurance state that was actually written. Callers MUST layer
 * further updates onto this value, never onto the pre-write snapshot they read
 * at transaction start: that snapshot has no attempt, and re-deriving from it
 * silently drops the attempt record the host needs to bind reviewer evidence.
 */
export async function persistReviewObligation(
  sessDir: string,
  state: SessionState,
  obligation: ReviewObligation,
  reviewMaterial?: ReviewMaterial,
  repositoryDiscovery: ReviewAttemptDiscoveryContext = { kind: 'not_applicable' },
): Promise<{ attemptId: string; assurance: ReviewAssuranceState }> {
  const result = appendObligationWithAttempt(
    state.reviewAssurance,
    obligation,
    obligation.createdAt,
    reviewMaterial,
    repositoryDiscovery,
  );
  await writeStateWithArtifacts(sessDir, {
    ...state,
    reviewAssurance: result.assurance,
  });
  return { attemptId: result.attemptId, assurance: result.assurance };
}

interface NewReviewObligationInput {
  readonly state: SessionState;
  readonly args: ReviewToolArgs;
  readonly now: string;
  readonly worktree: string | undefined;
  readonly resolvedSource: ResolvedBranchReviewSource | undefined;
  readonly preparedContent: PreparedReviewContent | undefined;
  readonly fingerprint: string;
  readonly inputFingerprint: string;
  readonly fingerprintVersion: 'v2';
}

export async function createNewReviewObligation(
  input: NewReviewObligationInput,
): Promise<{ obligation?: ReviewObligation; blocked?: string }> {
  const reviewSubject = input.preparedContent?.reviewSubject;
  if (!reviewSubject) {
    return {
      blocked: formatBlocked('REVIEW_SUBJECT_NOT_MATERIALIZED', {
        reason: 'Standalone review requires a frozen subject before creating an obligation.',
      }),
    };
  }
  // Repository subjects have already been materialized from immutable base/head
  // SHAs. Re-resolving a mutable branch or PR here could scope risk to different
  // paths than the subject the reviewer receives.
  const classification =
    reviewSubject.kind === 'repository_change'
      ? { kind: 'available' as const, changedFiles: reviewSubject.changedPaths }
      : await resolveChallengeClassificationEvidence(input.state, input.worktree, {
          targetPaths: input.args.targetPaths,
          branch: input.args.branch,
          base: input.args.base,
          prNumber: input.args.prNumber,
        });
  if (classification.kind === 'unavailable') {
    return {
      blocked: formatBlocked('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE', {
        reason: classification.reason,
      }),
    };
  }
  const resolvedTargetPaths =
    classification.kind === 'available'
      ? [...classification.changedFiles]
      : ([] as readonly string[]);
  const metadata: Record<string, unknown> = {
    fingerprint: input.fingerprint,
    inputFingerprint: input.inputFingerprint,
  };
  if (resolvedTargetPaths) {
    metadata.targetPaths = resolvedTargetPaths;
  }
  const reviewSubjectScope: ReviewSubjectScope =
    reviewSubject.kind === 'repository_change'
      ? {
          kind: 'repository_change',
          paths: [...reviewSubject.changedPaths],
          // The frozen source includes both SHAs, so findings may cite either side
          // of the reviewed diff without introducing free-form revision authority.
          revisions: ['base', 'head'],
        }
      : reviewSubject.kind === 'content'
        ? {
            kind: 'content',
            subjectDigest: reviewSubject.subjectDigest,
            lineCount: reviewSubject.lineCount,
          }
        : { kind: 'unavailable', reason: 'review_content_not_materialized' };
  return {
    obligation: createReviewObligation({
      obligationType: 'review',
      iteration: 1,
      planVersion: 1,
      now: input.now,
      subjectDigest: reviewSubject.subjectDigest,
      reviewSubject,
      reviewProfile: resolveFrozenReviewProfile(input.state.policySnapshot),
      profileSource: 'policy_default',
      policySnapshot: input.state.policySnapshot,
      changedFiles: resolvedTargetPaths,
      reviewSubjectScope,
      // Revision provenance is derived canonically from the frozen review
      // subject (base/head SHAs + repository identities) — never from
      // mutable runtime state.
      // No claimedTaskClass floor here: a standalone /review assesses an EXTERNAL
      // PR/branch/content whose risk is the reviewed diff itself (changedFiles),
      // not the session's own task-class claim. The C1 floor applies only to the
      // author's own change (plan/architecture/implement).
      metadata,
      fingerprintVersion: input.fingerprintVersion,
    }),
  };
}

export async function ensureMissingAnalysisObligation(
  sessDir: string,
  state: SessionState,
  args: ReviewToolArgs,
  now: string,
  context: Pick<NewReviewObligationInput, 'worktree' | 'resolvedSource' | 'preparedContent'>,
): Promise<{
  message: string | null;
  obligation?: ReviewObligation;
  attemptId?: string;
  /** Set only when this call wrote state; authoritative over the caller's snapshot. */
  assurance?: ReviewAssuranceState;
}> {
  const sourceResult = validateReviewContentSource(args);
  if (sourceResult.kind === 'none') return { message: null };
  if (sourceResult.kind === 'incomplete') {
    return { message: sourceResult.blockMessage };
  }

  if (!hasReviewContentInput(args)) return { message: null };

  const fingerprint = fingerprintReviewInput(
    {
      ...args,
      resolvedBranchSha: context.resolvedSource?.resolvedBranchSha,
      resolvedBaseSha: context.resolvedSource?.resolvedBaseSha,
    },
    'v2',
  );
  const inputFingerprint = fingerprintReviewInput(args, 'v2');
  const existing = findLatestPendingReviewObligation(
    state.reviewAssurance,
    'review',
    fingerprint,
    'v2',
  );
  const verdictFirstCall = args.reviewVerdict !== undefined && existing === null;
  if (!verdictFirstCall && args.reviewFindings !== undefined) return { message: null };
  if (!existing) {
    return createAndPrepareMissingAnalysisObligation({
      sessDir,
      state,
      args,
      now,
      context,
      fingerprint,
      inputFingerprint,
      fingerprintVersion: 'v2',
    });
  }
  return reissueAttemptForPendingObligation(sessDir, state, existing, now);
}

/**
 * Re-invocation of a still-pending review obligation: hand the host a bindable
 * attempt again.
 *
 * A fresh attempt may be issued only after the previous reviewer attempt
 * produced a non-bindable output-contract failure classified as canonically
 * repairable (`REVIEW_ATTEMPT_REJECTION_POLICY`). Governance failures,
 * subject/material integrity failures, scope failures, and execution failures
 * do not authorize this reissue path.
 *
 * Reissue authorization is delegated to `authorizeOutputRepairReissue`:
 * pending obligation + no bindable attempt + latest attempt `rejected` with an
 * explicit structured reason + `canonical_output_retry` policy + remaining
 * frozen budget (`maxReviewerOutputRepairAttempts`, frozen onto the obligation
 * at creation). On denial the obligation is deterministically blocked with the
 * denial code — `/status` must not recommend a further reviewer retry.
 *
 * Reissuing while a bindable attempt is still open is refused: the open
 * attempt is returned as-is so an in-flight reviewer Task is never staled.
 */
async function reissueAttemptForPendingObligation(
  sessDir: string,
  state: SessionState,
  existing: ReviewObligation,
  now: string,
): Promise<{
  message: string | null;
  obligation?: ReviewObligation;
  attemptId?: string;
  assurance?: ReviewAssuranceState;
}> {
  const message = formatMissingContentAnalysis(
    existing.obligationId,
    state.policySnapshot?.reviewInvocationPolicy === 'host_task_required',
  );
  const authorization = authorizeOutputRepairReissue(state.reviewAssurance, existing);
  if (authorization.kind === 'bindable_exists') {
    return { message, obligation: existing, attemptId: authorization.attemptId };
  }
  if (authorization.kind === 'integrity_blocked') {
    // Broken frozen subject/material binding: refuse with ZERO state mutation.
    // Blocking the obligation or staling attempts would mutate governance
    // state on top of an unverifiable immutable foundation.
    return {
      message: formatBlocked(authorization.code, {
        obligationId: existing.obligationId,
        reason: authorization.reason,
      }),
    };
  }
  if (authorization.kind === 'blocked') {
    const blockedState = blockObligation(state, existing.obligationId, authorization.code);
    await writeStateWithArtifacts(sessDir, blockedState);
    return {
      message: formatBlocked(authorization.code, {
        obligationId: existing.obligationId,
        reason: authorization.reason,
      }),
    };
  }
  // Attempt-bound Discovery context resolved BEFORE the repair attempt is
  // minted — a fresh host-owned snapshot for repository reviews. A structural
  // projection failure blocks with zero state mutation.
  const discovery = await resolveReviewAttemptDiscoveryContext({
    state,
    worktree: state.binding.worktree,
    repositoryGoverned: hasFrozenRepositoryAuthority(existing),
    now,
  });
  if (discovery.kind === 'blocked') {
    return {
      message: formatBlocked('REVIEWER_CONTEXT_UNAVAILABLE', {
        obligationId: existing.obligationId,
        reason: discovery.reason,
      }),
    };
  }
  const reissue = createAttemptForExistingObligation(
    state.reviewAssurance,
    existing,
    undefined,
    now,
    {
      origin: {
        kind: 'output_repair',
        predecessorAttemptId: authorization.predecessorAttemptId,
        triggerReason: authorization.triggerReason,
      },
      repositoryDiscovery: discovery.context,
    },
  );
  await writeStateWithArtifacts(sessDir, { ...state, reviewAssurance: reissue.assurance });
  return {
    message,
    obligation: existing,
    attemptId: reissue.attempt.attemptId,
    assurance: reissue.assurance,
  };
}

interface MissingAnalysisObligationInput {
  readonly sessDir: string;
  readonly context: Pick<
    NewReviewObligationInput,
    'worktree' | 'resolvedSource' | 'preparedContent'
  >;
  readonly state: SessionState;
  readonly args: ReviewToolArgs;
  readonly now: string;
  readonly fingerprint: string;
  readonly inputFingerprint: string;
  readonly fingerprintVersion: 'v2';
}

async function createAndPrepareMissingAnalysisObligation(
  input: MissingAnalysisObligationInput,
): Promise<{
  message: string | null;
  obligation?: ReviewObligation;
  attemptId?: string;
  assurance?: ReviewAssuranceState;
}> {
  const created = await createNewReviewObligation({
    state: input.state,
    args: input.args,
    now: input.now,
    fingerprint: input.fingerprint,
    inputFingerprint: input.inputFingerprint,
    fingerprintVersion: input.fingerprintVersion,
    ...input.context,
  });
  if (created.blocked) return { message: created.blocked };
  const obligation = created.obligation!;
  const preparedContent = input.context.preparedContent;
  // Attempt-bound Discovery context is resolved BEFORE the attempt is minted:
  // a repository review attempt is born with its host-owned snapshot. The
  // loader is advisory-total, so this blocks only on a structural projection
  // failure — a degraded/unavailable snapshot mints with NOT_VERIFIED markers.
  const discovery = await resolveReviewAttemptDiscoveryContext({
    state: input.state,
    worktree: input.context.worktree ?? input.state.binding.worktree,
    repositoryGoverned: hasFrozenRepositoryAuthority(obligation),
    now: input.now,
  });
  if (discovery.kind === 'blocked') {
    return {
      message: formatBlocked('REVIEWER_CONTEXT_UNAVAILABLE', {
        obligationId: obligation.obligationId,
        reason: discovery.reason,
      }),
    };
  }
  const persisted = await persistReviewObligation(
    input.sessDir,
    input.state,
    obligation,
    preparedContent
      ? {
          content: preparedContent.content,
          materialDigest: preparedContent.reviewSubject.materialDigest,
        }
      : undefined,
    discovery.context,
  );
  return {
    message: formatMissingContentAnalysis(
      obligation.obligationId,
      input.state.policySnapshot?.reviewInvocationPolicy === 'host_task_required',
    ),
    obligation,
    attemptId: persisted.attemptId,
    assurance: persisted.assurance,
  };
}
