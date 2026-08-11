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
  ensureReviewAssurance,
  createReviewAttempt,
  appendReviewAttempt,
  staleObligationAttempts,
} from '../../review/assurance.js';
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
 * Used when the prior attempt was rejected (invalid reviewer output, out-of-scope
 * findings, etc.) and the host must re-issue reviewer-task guidance. The new
 * attempt is created without a child session — the after-hook binds the child
 * session when the reviewer Task completes.
 *
 * Persists the updated assurance state and returns the new `ReviewAttempt` with
 * its `attemptId` for inclusion in the blocked response so enforcement tracking
 * can register it before the next Task invocation.
 */
export async function reissueReviewAttempt(
  sessDir: string,
  state: SessionState,
  opts: {
    readonly obligationId: string;
    readonly subjectDigest: string;
    readonly obligationType: string;
  },
  now: string,
): Promise<ReviewAttempt> {
  const base = ensureReviewAssurance(state.reviewAssurance);
  const ordinal =
    (base.attempts?.filter((a) => a.obligationId === opts.obligationId).length ?? 0) + 1;
  const attempt = createReviewAttempt({
    obligationId: opts.obligationId,
    obligationType: opts.obligationType as ReviewAttempt['obligationType'],
    subjectDigest: opts.subjectDigest,
    reviewMaterial: latestReviewMaterial(base, opts.obligationId),
    ordinal,
    now,
  });
  const withAttempt = appendReviewAttempt(base, attempt);
  const reissue = staleObligationAttempts(withAttempt, opts.obligationId, attempt.attemptId, now);
  await writeStateWithArtifacts(sessDir, { ...state, reviewAssurance: reissue });
  return attempt;
}

function latestReviewMaterial(
  assurance: ReturnType<typeof ensureReviewAssurance>,
  obligationId: string,
): ReviewAttempt['reviewMaterial'] {
  for (let index = assurance.attempts.length - 1; index >= 0; index--) {
    const attempt = assurance.attempts[index];
    if (attempt?.obligationId === obligationId && attempt.reviewMaterial) {
      return attempt.reviewMaterial;
    }
  }
  return undefined;
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
