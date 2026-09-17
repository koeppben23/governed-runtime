/**
 * @module integration/tools/review-tool/continuation
 * @description Review phase continuation helpers.
 *
 * When the initial review preparation materializes the PEER_REVIEW phase, subsequent
 * calls (verdict submission, retry) must continue the existing review rather
 * than re-entering the user-level /review start rail.
 */

import { formatRailResult } from '../helpers.js';
import { startReviewFlow } from '../../../rails/review.js';
import { findReviewObligationById } from '../../review/assurance.js';
import type { SessionState } from '../../../state/schema.js';
import type { StartedReviewResult } from './types.js';

export function ensureStartedReviewState(
  state: SessionState,
  ctx: Parameters<typeof startReviewFlow>[1],
): StartedReviewResult | string {
  if (state.phase === 'PEER_REVIEW') {
    return {
      kind: 'ok' as const,
      state,
      evalResult: { kind: 'pending', phase: 'PEER_REVIEW' as const },
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
