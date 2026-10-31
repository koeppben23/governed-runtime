/** Native history is preserved, not converted into superseded message/part
 * evidence. Regular edit-error terminality in V2 is a separate unverified gate. */
import type { MutationEpisode } from '../state/evidence-mutation-episode.js';

export type MutationObservation =
  | { readonly kind: 'observed'; readonly completedAt: string }
  | { readonly kind: 'unobserved'; readonly reason: string };

/** A native error state, completion time or notification alone does not prove
 * regular termination (as opposed to cleanup/interruption). No positive V2
 * error-history contract is admitted until the pinned host supplies that proof.
 * Successful execute.after observations remain under their existing owner. */
export function observeEditFailure(
  _history: unknown,
  _sessionId: string,
  _episode: MutationEpisode,
): MutationObservation {
  return {
    kind: 'unobserved',
    reason: 'Pinned V2 regular edit-error terminal-history provenance is NOT_VERIFIED.',
  };
}
