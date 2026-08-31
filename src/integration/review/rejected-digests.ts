/**
 * @module integration/review/rejected-digests
 * @description Pure projection of implementation digests that an independent
 *              reviewer has EVER rejected in this session's history.
 *
 * The append-only evidence is the load-bearing authority here: fulfilled
 * obligations are retained (status `consumed`/`fulfilled`, never deleted), every
 * implementation obligation freezes its exact implementation digest in
 * `reviewSubjectScope`, and every bound implementation finding carries the
 * owning obligation's id in `attestation.toolObligationId` plus its
 * `overallVerdict`. Deriving the rejected set from that history closes the
 * multi-round reuse loophole: a digest rejected in round N must remain blocked
 * after a LATER round has passed (and the single-slot `implementationRework`
 * marker moved on to a different digest).
 */
import type { SessionState } from '../../state/schema.js';

export function collectHistoricallyRejectedImplementationDigests(
  state: SessionState,
): ReadonlySet<string> {
  const obligationsById = new Map(
    (state.reviewAssurance?.obligations ?? []).map((o) => [o.obligationId, o]),
  );
  const rejected = new Set<string>();
  for (const finding of state.implReviewFindings ?? []) {
    if (finding.overallVerdict !== 'changes_requested') continue;
    const obligationId = finding.attestation?.toolObligationId;
    if (!obligationId) continue;
    const obligation = obligationsById.get(obligationId);
    if (!obligation || obligation.obligationType !== 'implement') continue;
    const scope = obligation.reviewSubjectScope;
    if (scope.kind !== 'implementation') continue;
    rejected.add(scope.implementationDigest);
  }
  return rejected;
}
