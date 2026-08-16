/**
 * @module integration/review/freeze-coherence
 * @description Creation-time coherence guard for the durable repository
 *              evidence freeze record.
 *
 * The persistence boundary enforces the same invariant structurally via
 * {@link refineRepositoryEvidenceFreezeCoherence} (ReviewObligation schema
 * superRefine); this assert fails fast at obligation minting so incoherent
 * state never even reaches persistence.
 *
 * @version v1
 */
import type { FrozenRepositoryAuthority } from '../../state/evidence.js';
import type { ReviewObligationType } from '../../state/evidence.js';
import type { RepositoryEvidenceFreeze } from '../../state/evidence-review-freeze.js';

/**
 * Invariant (no third state, no legacy exception):
 *   obligationType ∈ {plan, architecture} ⇒ the record MUST exist
 *   freeze.kind === 'available'   ⇔ repositoryAuthority present
 *   freeze.kind === 'unavailable' ⇒ repositoryAuthority absent
 *
 * Review/implement obligations never run the context freeze and must not
 * carry the record.
 */
export function assertRepositoryFreezeCoherence(input: {
  obligationType: ReviewObligationType;
  repositoryAuthority?: FrozenRepositoryAuthority;
  repositoryEvidenceFreeze?: RepositoryEvidenceFreeze;
}): void {
  const contextFreezeObligation =
    input.obligationType === 'plan' || input.obligationType === 'architecture';
  const freeze = input.repositoryEvidenceFreeze;
  if (!contextFreezeObligation) {
    if (freeze) {
      throw new Error(
        'FAIL_CLOSED: only plan/architecture obligations carry a repository evidence freeze record',
      );
    }
    return;
  }
  if (!freeze) {
    throw new Error(
      'FAIL_CLOSED: plan/architecture obligations require a repository evidence freeze record',
    );
  }
  if (freeze.kind === 'available' && !input.repositoryAuthority) {
    throw new Error(
      'FAIL_CLOSED: an available repository freeze record requires a frozen repository authority',
    );
  }
  if (freeze.kind === 'unavailable' && input.repositoryAuthority) {
    throw new Error(
      'FAIL_CLOSED: an unavailable repository freeze record forbids a frozen repository authority',
    );
  }
}
