/**
 * @module integration/tools/review-tool/continuation-authority
 * @description Who may continue an existing review obligation, and with which
 *              immutable source.
 *
 * Owns branch-source resolution for a named obligation.
 * Extracted from index.ts along the continuation-authority boundary; index.ts
 * re-exports the surface it needs.
 *
 * @version v1
 */

import type { SessionState } from '../../../state/schema.js';
import { resolveBranchReviewSource } from '../../../adapters/gh-cli.js';
import { findReviewObligationById } from '../../review/assurance.js';
import type { ReviewObligation } from '../../../state/evidence.js';
import { repositoryFromBranchSubject } from './obligation-format.js';
import type { ReviewExecutionContext } from './types.js';

/**
 * Resolve the immutable branch source, but only when an obligation is being
 * created. A named obligation uses its persisted source when available.
 */
export function resolveObligationBranchSource(
  state: SessionState,
  exec: ReviewExecutionContext,
): ReturnType<typeof resolveBranchReviewSource> | undefined {
  if (!exec.args.branch) return undefined;
  const persistedSource = getPersistedObligationBranchSource(state, exec);
  if (persistedSource) return persistedSource;
  return resolveBranchReviewSource(exec.args.branch, exec.args.base, exec.context.worktree);
}

/**
 * The base BRANCH LABEL of a persisted obligation's frozen subject, when the
 * subject is a branch-based repository review. Presentation label only — the
 * resolved SHAs remain the authority.
 */
function frozenRequestedBaseOf(obligation: ReviewObligation | undefined): string | undefined {
  const subject = obligation?.reviewSubject;
  if (subject?.kind === 'repository_change' && subject.source.kind === 'branch') {
    return subject.source.requestedBase;
  }
  return undefined;
}

/** Resolve the obligation an explicit reviewObligationId references. */
function obligationById(
  state: SessionState,
  exec: ReviewExecutionContext,
): ReviewObligation | undefined {
  if (!exec.args.reviewObligationId) return undefined;
  return findReviewObligationById(state.reviewAssurance, exec.args.reviewObligationId) ?? undefined;
}

function getPersistedObligationBranchSource(
  state: SessionState,
  exec: ReviewExecutionContext,
): ReturnType<typeof resolveBranchReviewSource> | undefined {
  if (!exec.args.branch) return undefined;
  const obligation = obligationById(state, exec);
  const provenance = obligation?.repositoryRevisionProvenance;
  if (provenance?.kind !== 'available' || !provenance.baseSha) return undefined;
  return {
    branch: exec.args.branch,
    baseBranch: exec.args.base ?? frozenRequestedBaseOf(obligation) ?? provenance.baseSha,
    resolvedBranchSha: provenance.headSha,
    resolvedBaseSha: provenance.baseSha,
    repository: repositoryFromBranchSubject(obligation?.reviewSubject),
  };
}
