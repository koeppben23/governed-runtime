/**
 * @module integration/tools/review-tool/continuation
 * @description Review phase continuation helpers.
 *
 * When the initial review preparation materializes the REVIEW phase, subsequent
 * calls (verdict submission, retry) must continue the existing review rather
 * than re-entering the user-level /review start rail.
 */

import { formatRailResult } from '../helpers.js';
import { startReviewFlow } from '../../../rails/review.js';
import {
  findReviewObligationById,
  createAttemptForExistingObligation,
} from '../../review/assurance.js';
import {
  authorizeOutputRepairReissue,
  type OutputRepairAuthorization,
} from '../../review/reissue-authority.js';
import { blockObligation } from '../../review/obligation-state.js';
import { writeStateWithArtifacts } from '../helpers.js';
import type { SessionState } from '../../../state/schema.js';
import type { StartedReviewResult } from './types.js';
import type { ReviewAttempt, ReviewObligation } from '../../../state/evidence-review.js';

export function ensureStartedReviewState(
  state: SessionState,
  ctx: Parameters<typeof startReviewFlow>[1],
): StartedReviewResult | string {
  if (state.phase === 'REVIEW') {
    return {
      kind: 'ok' as const,
      state,
      evalResult: { kind: 'pending', phase: 'REVIEW' as const },
      transitions: [],
    };
  }
  const start = startReviewFlow(state, ctx);
  if (start.kind === 'blocked') return String(formatRailResult(start));
  return start;
}

export function resolveObligationResolvedRefs(
  state: SessionState,
  obligationId: string,
): { readonly resolvedBranchSha?: string; readonly resolvedBaseSha?: string } | undefined {
  const obligation = findReviewObligationById(state.reviewAssurance, obligationId);
  if (!obligation?.metadata) return undefined;
  const meta = obligation.metadata;
  const branchSha = typeof meta.resolvedBranchSha === 'string' ? meta.resolvedBranchSha : undefined;
  const baseSha = typeof meta.resolvedBaseSha === 'string' ? meta.resolvedBaseSha : undefined;
  if (!branchSha || !baseSha) return undefined;
  return { resolvedBranchSha: branchSha, resolvedBaseSha: baseSha };
}

/** Host-authored attestation fields required to regenerate a reviewer Task prompt. */
export function buildHostTaskAttestation(obligation: ReviewObligation): Record<string, unknown> {
  return {
    toolObligationId: obligation.obligationId,
    mandateDigest: obligation.mandateDigest,
    criteriaVersion: obligation.criteriaVersion,
    iteration: obligation.iteration,
    planVersion: obligation.planVersion,
  };
}

/**
 * Reissue a bindable review attempt for an existing obligation.
 *
 * Used when the prior attempt was rejected and the host must re-issue
 * reviewer-task guidance. The new attempt is created without a child session —
 * the after-hook binds the child session when the reviewer Task completes.
 *
 * Authorization is delegated to `authorizeOutputRepairReissue` (pending
 * obligation, no bindable attempt, latest attempt rejected with an explicit
 * canonically repairable reason, remaining frozen output-repair budget). On
 * denial the obligation is deterministically blocked with the denial code and
 * the caller receives the blocked message instead of an attempt identity.
 *
 * Attempt construction is delegated to the canonical
 * `createAttemptForExistingObligation` authority so ordinal assignment, material
 * carry-forward, and staling of superseded attempts cannot drift between the
 * verdict-continuation path and the pre-Task repair path. The origin is always
 * `output_repair` with the rejected predecessor and its trigger reason.
 *
 * Persists the updated assurance state and returns the new `ReviewAttempt` with
 * its `attemptId` for inclusion in the blocked response so enforcement tracking
 * can register it before the next Task invocation.
 */
export type ReissueReviewAttemptResult =
  | { readonly kind: 'ok'; readonly attempt: ReviewAttempt }
  | {
      readonly kind: 'blocked';
      readonly authorization: Extract<
        OutputRepairAuthorization,
        { readonly kind: 'blocked' | 'integrity_blocked' }
      >;
      /** False for integrity failures: the refusal must not mutate state. */
      readonly obligationBlocked: boolean;
    };

export async function reissueReviewAttempt(
  sessDir: string,
  state: SessionState,
  obligation: ReviewObligation,
  now: string,
): Promise<ReissueReviewAttemptResult> {
  const authorization = authorizeOutputRepairReissue(state.reviewAssurance, obligation);
  if (authorization.kind === 'integrity_blocked') {
    // Broken frozen subject/material binding: refuse with ZERO state mutation.
    return { kind: 'blocked', authorization, obligationBlocked: false };
  }
  if (authorization.kind === 'blocked') {
    const blockedState = blockObligation(state, obligation.obligationId, authorization.code);
    await writeStateWithArtifacts(sessDir, blockedState);
    return { kind: 'blocked', authorization, obligationBlocked: true };
  }
  if (authorization.kind === 'bindable_exists') {
    const existing = state.reviewAssurance?.attempts.find(
      (a) => a.attemptId === authorization.attemptId,
    );
    if (!existing) {
      return {
        kind: 'blocked',
        authorization: {
          kind: 'blocked',
          code: 'REVIEW_REPAIR_UNAVAILABLE',
          reason: 'bindable attempt referenced by authorization is missing from state',
        },
        obligationBlocked: false,
      };
    }
    return { kind: 'ok', attempt: existing };
  }
  const reissue = createAttemptForExistingObligation(
    state.reviewAssurance,
    obligation,
    undefined,
    now,
    {
      kind: 'output_repair',
      predecessorAttemptId: authorization.predecessorAttemptId,
      triggerReason: authorization.triggerReason,
    },
  );
  await writeStateWithArtifacts(sessDir, { ...state, reviewAssurance: reissue.assurance });
  return { kind: 'ok', attempt: reissue.attempt };
}

import { buildReviewReferenceInput } from './obligation.js';
import type { ReviewToolArgs } from './types.js';
import type { ReviewReferenceInput } from '../../../rails/review.js';

export function populateRefInput(
  args: ReviewToolArgs,
  state: SessionState,
  resolvedSource:
    | { branch: string; baseBranch: string; resolvedBranchSha: string; resolvedBaseSha: string }
    | undefined,
): ReviewReferenceInput | undefined {
  let refInput = buildReviewReferenceInput(args);
  if (!refInput) return undefined;
  if (resolvedSource) {
    refInput = { ...refInput, ...resolvedSource };
  } else if (args.branch && args.reviewObligationId) {
    const meta = resolveObligationResolvedRefs(state, args.reviewObligationId);
    if (meta) refInput = { ...refInput, ...meta };
  }
  return refInput;
}
