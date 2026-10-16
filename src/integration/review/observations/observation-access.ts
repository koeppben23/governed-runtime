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

import type { ReviewAttempt, ReviewObligation } from '../../../state/evidence.js';
import {
  resolveFrozenRevisionTarget,
  resolveObservationRevisions,
  type FrozenRepositoryRevisionTargetValue,
} from '../../../state/evidence-review-authority.js';
import type { RepositoryEvidenceFreeze } from '../../../state/evidence-review-freeze.js';

/**
 * Outcome of one requested observation revision against the obligation's
 * frozen authority. `not_offered` and `no_authority` are distinct: a revision
 * outside the offer says nothing about the offered revisions, which stay
 * observable; only `no_authority` means repository evidence is unavailable.
 */
export type ObservationRevisionRequest =
  | { readonly kind: 'offered'; readonly target: FrozenRepositoryRevisionTargetValue }
  | { readonly kind: 'not_offered'; readonly offeredRevisions: readonly ('base' | 'head')[] }
  | { readonly kind: 'no_authority' };

/** Resolve a requested revision through the same SSOT that advertises revisions. */
export function resolveObservationRevisionRequest(
  obligation: ReviewObligation,
  revision: 'base' | 'head',
): ObservationRevisionRequest {
  const target = resolveFrozenRevisionTarget(obligation, revision);
  if (target) return { kind: 'offered', target };
  const offeredRevisions = resolveObservationRevisions(obligation);
  return offeredRevisions.length > 0
    ? { kind: 'not_offered', offeredRevisions }
    : { kind: 'no_authority' };
}

export type RepositoryObservationAccessUnavailableReason = 'no_frozen_authority';

export type RepositoryObservationAccess =
  | {
      readonly available: true;
      readonly capability: string;
      readonly revisions: readonly ('base' | 'head')[];
    }
  | {
      readonly available: false;
      readonly revisions: readonly ('base' | 'head')[];
      readonly reason: RepositoryObservationAccessUnavailableReason;
    };

/**
 * Resolve the reviewer's actual repository observation access for one attempt.
 *
 * Defense-in-depth: even when the attempt carries a capability string, access
 * stays unavailable unless the OBLIGATION backs at least one frozen revision.
 * Current-generation states enforce the stronger invariant at the schema
 * boundary (repository-governed attempts REQUIRE a capability), so a missing
 * capability here can only be an invalid state and fails closed.
 */
export function resolveRepositoryObservationAccess(
  obligation: ReviewObligation,
  attempt: ReviewAttempt,
): RepositoryObservationAccess {
  const revisions = resolveObservationRevisions(obligation);
  const capability = attempt.observationCapability;
  if (revisions.length > 0 && capability) {
    return { available: true, capability, revisions };
  }
  return { available: false, revisions, reason: 'no_frozen_authority' };
}

/**
 * Response field surfacing a degraded repository-evidence freeze. Every
 * artifact-flow response (plan, architecture submit/review/restart) spreads
 * the same shape; available freezes contribute nothing. Accepts both the
 * live freeze result and the durable obligation record so continuations,
 * restarts, and re-emits render the exact persisted cause.
 */
export function repositoryEvidenceUnavailableField(
  freeze: RepositoryEvidenceFreeze | null | undefined,
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
