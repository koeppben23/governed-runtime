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
import type { RepositoryEvidenceFreeze } from '../../state/evidence-review-freeze.js';

/**
 * Invariant:
 *   freeze.kind === 'available'   ⇔ repositoryAuthority present
 *   freeze.kind === 'unavailable' ⇒ repositoryAuthority absent
 *
 * A missing freeze record is legal (legacy obligations, standalone /review,
 * implement flows).
 */
export function assertRepositoryFreezeCoherence(input: {
  repositoryAuthority?: FrozenRepositoryAuthority;
  repositoryEvidenceFreeze?: RepositoryEvidenceFreeze;
}): void {
  const freeze = input.repositoryEvidenceFreeze;
  if (!freeze) return;
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
