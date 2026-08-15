/**
 * @module integration/review/observation-access
 * @description Single source of truth for repository observation access.
 *
 * The observation permission a reviewer receives is ALWAYS derived from the
 * owning obligation's frozen repository authority — never from the attempt
 * record alone. Attempts are persisted, untrusted state: a legacy fixture or
 * manipulated session may carry a capability string without any backing
 * frozen authority. The authoritative resolution therefore probes the frozen
 * revision targets on the OBLIGATION and only then consults the attempt's
 * opaque capability.
 *
 * Invariant:
 *   attempt.observationCapability exists
 *   IFF at least one frozen revision resolves via resolveFrozenRevisionTarget
 *   for the owning obligation.
 *
 * Prompt-advertised revisions == exact revisions accepted by
 * resolveFrozenRevisionTarget (context → ['head'], candidate_pair or
 * repository_change fallback → ['base', 'head'], none otherwise).
 *
 * @version v1
 */

import type { ReviewAttempt, ReviewObligation } from '../../state/evidence.js';
import { resolveFrozenRevisionTarget } from '../../state/evidence-review-authority.js';
import type { RepositoryAuthorityFreezeResult } from '../../rails/repository-authority.js';

/** The exact frozen revisions an obligation can actually back with evidence. */
export function resolveObservationRevisions(
  obligation: ReviewObligation,
): readonly ('base' | 'head')[] {
  const revisions: ('base' | 'head')[] = [];
  for (const revision of ['base', 'head'] as const) {
    if (resolveFrozenRevisionTarget(obligation, revision)) revisions.push(revision);
  }
  return revisions;
}

export type RepositoryObservationAccess =
  | {
      readonly available: true;
      readonly capability: string;
      readonly revisions: readonly ('base' | 'head')[];
    }
  | {
      readonly available: false;
      readonly revisions: readonly ('base' | 'head')[];
      readonly reason: 'no_frozen_authority';
    };

/**
 * Resolve the reviewer's actual repository observation access for one attempt.
 *
 * Defense-in-depth: even when the attempt carries a capability string, access
 * stays unavailable unless the OBLIGATION backs at least one frozen revision.
 */
export function resolveRepositoryObservationAccess(
  obligation: ReviewObligation,
  attempt: ReviewAttempt,
): RepositoryObservationAccess {
  const revisions = resolveObservationRevisions(obligation);
  const capability = attempt.observationCapability ?? null;
  if (revisions.length > 0 && capability !== null) {
    return { available: true, capability, revisions };
  }
  return { available: false, revisions, reason: 'no_frozen_authority' };
}

/**
 * Response field surfacing a degraded repository-evidence freeze. Every
 * artifact-flow response (plan, architecture submit/review/restart) spreads
 * the same shape; available freezes contribute nothing.
 */
export function repositoryEvidenceUnavailableField(
  freeze: RepositoryAuthorityFreezeResult | null,
): Record<string, unknown> {
  if (freeze?.kind !== 'unavailable') return {};
  return {
    repositoryEvidence: {
      available: false,
      reason: freeze.reason,
      ...(freeze.diagnostic ? { diagnostic: freeze.diagnostic } : {}),
    },
  };
}
