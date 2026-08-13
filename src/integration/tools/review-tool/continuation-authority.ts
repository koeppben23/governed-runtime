/**
 * @module integration/tools/review-tool/continuation-authority
 * @description Who may continue an existing review obligation, and with which
 *              immutable source.
 *
 * Owns branch-source resolution for a named obligation and the host-task
 * verdict continuation authority (explicit id, ambiguous, or id required).
 * Extracted from index.ts along the continuation-authority boundary; index.ts
 * re-exports the surface it needs.
 *
 * @version v1
 */

import type { SessionState } from '../../../state/schema.js';
import { resolveBranchReviewSource } from '../../../adapters/gh-cli.js';
import { findReviewObligationById } from '../../review/assurance.js';
import type { ReviewObligation } from '../../../state/evidence.js';
import { formatBlocked } from '../helpers.js';
import { repositoryFromBranchSubject } from './obligation-format.js';
import { hasReviewContentInput } from './review-input.js';
import type { ReviewExecutionContext } from './types.js';

/**
 * Resolve the immutable branch source, but only when an obligation is being
 * created. An explicit host-task continuation is bound to its existing
 * obligation and must not re-resolve refs.
 */
export function resolveObligationBranchSource(
  state: SessionState,
  exec: ReviewExecutionContext,
): ReturnType<typeof resolveBranchReviewSource> | undefined {
  if (!exec.args.branch) return undefined;
  const persistedSource = getPersistedObligationBranchSource(state, exec);
  if (persistedSource) return persistedSource;
  if (isHostTaskVerdictContinuation(exec)) return undefined;
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
function obligationByIdOrAttestation(
  state: SessionState,
  exec: ReviewExecutionContext,
): ReviewObligation | undefined {
  const findingsObligationId = (
    exec.args.reviewFindings as { attestation?: { toolObligationId?: string } }
  )?.attestation?.toolObligationId;
  const obligationId = exec.args.reviewObligationId ?? findingsObligationId;
  if (!obligationId) return undefined;
  return findReviewObligationById(state.reviewAssurance, obligationId) ?? undefined;
}

function getPersistedObligationBranchSource(
  state: SessionState,
  exec: ReviewExecutionContext,
): ReturnType<typeof resolveBranchReviewSource> | undefined {
  if (!exec.args.branch) return undefined;
  const obligation = obligationByIdOrAttestation(state, exec);
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

export function isHostTaskVerdictContinuation(exec: ReviewExecutionContext): boolean {
  return (
    exec.policy === 'host_task_required' &&
    exec.args.reviewVerdict !== undefined &&
    exec.args.reviewObligationId !== undefined
  );
}

type HostTaskContinuationAuthority =
  | { readonly kind: 'not_applicable' }
  | {
      readonly kind: 'explicit';
      readonly reviewObligationId: string;
      readonly reviewVerdict: 'accept' | 'changes_requested';
    }
  | {
      readonly kind: 'id_required';
      readonly compatibleObligationIds: readonly string[];
    }
  | {
      readonly kind: 'ambiguous';
      readonly compatibleObligationIds: readonly string[];
    };

export function resolveHostTaskContinuationAuthority(
  state: SessionState,
  exec: ReviewExecutionContext,
): HostTaskContinuationAuthority {
  if (exec.policy !== 'host_task_required' || exec.args.reviewVerdict === undefined) {
    return { kind: 'not_applicable' };
  }
  if (exec.args.reviewObligationId !== undefined) {
    return {
      kind: 'explicit',
      reviewObligationId: exec.args.reviewObligationId,
      reviewVerdict: exec.args.reviewVerdict,
    };
  }
  // A verdict accompanying content can be the first call; obligation creation
  // remains authoritative for that path rather than guessing a continuation.
  if (hasReviewContentInput(exec.args)) return { kind: 'not_applicable' };
  const compatibleObligationIds = (state.reviewAssurance?.obligations ?? [])
    .filter(
      (obligation) =>
        obligation.obligationType === 'review' &&
        obligation.status !== 'consumed' &&
        obligation.status !== 'blocked',
    )
    .filter((obligation) =>
      (state.reviewAssurance?.invocations ?? []).some(
        (invocation) =>
          invocation.obligationId === obligation.obligationId &&
          invocation.invocationMode === 'host_subagent_task' &&
          invocation.hostVisible === true &&
          invocation.capturedRawFindings != null &&
          invocation.capturedVerdict === exec.args.reviewVerdict &&
          (obligation.invocationId === invocation.invocationId ||
            invocation.attemptId !== undefined),
      ),
    )
    .map((obligation) => obligation.obligationId);
  return compatibleObligationIds.length > 1
    ? { kind: 'ambiguous', compatibleObligationIds }
    : { kind: 'id_required', compatibleObligationIds };
}

function formatHostTaskContinuationAuthority(
  authority: HostTaskContinuationAuthority,
): string | null {
  if (authority.kind === 'not_applicable' || authority.kind === 'explicit') return null;
  if (authority.kind === 'ambiguous') {
    return formatBlocked('REVIEW_OBLIGATION_AMBIGUOUS', {
      obligationIds: authority.compatibleObligationIds.join(', '),
      reason:
        'More than one compatible host-task review obligation has captured the supplied verdict. Supply reviewObligationId explicitly.',
    });
  }
  return formatBlocked('REVIEW_OBLIGATION_ID_REQUIRED', {
    reason:
      'A host-task review verdict requires reviewObligationId unless this is the first content-aware review call.',
    ...(authority.compatibleObligationIds.length === 1
      ? { reviewObligationId: authority.compatibleObligationIds[0]! }
      : {}),
    continuation:
      'Call flowguard_review with the original content fields, reviewObligationId, and reviewVerdict.',
  });
}

export function missingHostTaskVerdictBlock(
  state: SessionState,
  exec: ReviewExecutionContext,
): string | null {
  return formatHostTaskContinuationAuthority(resolveHostTaskContinuationAuthority(state, exec));
}
