/**
 * @module adapters/implementation-entry-guard
 * @description Pure persistence-side guard for the implementation-entry
 *              invariant:
 *
 *   persist state with phase === IMPLEMENTATION
 *   ⇒ implementationBaseAuthority already frozen
 *
 * Deliberately dependency-free (type-only state import): the guard is invoked
 * from the lowest persistence boundary (`writeStateAlreadyLocked`) and must
 * not create an import cycle with the git adapter that performs the freeze.
 * The freeze authority itself lives in `implementation-base-authority.ts`,
 * which re-uses the canonical code exported here.
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';

/** Canonical blocked code for a failed implementation-entry freeze. */
export const IMPLEMENTATION_BASE_FREEZE_FAILED_CODE = 'REVIEW_IMPLEMENTATION_BASE_FREEZE_FAILED';

/**
 * Typed error for the implementation-entry invariant: an IMPLEMENTATION-phase
 * state cannot be persisted without a frozen implementation base authority.
 * Always carries the canonical {@link IMPLEMENTATION_BASE_FREEZE_FAILED_CODE}.
 */
export class ImplementationBaseAuthorityError extends Error {
  readonly code = IMPLEMENTATION_BASE_FREEZE_FAILED_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'ImplementationBaseAuthorityError';
  }
}

/**
 * Refuse to persist an IMPLEMENTATION-phase state without a frozen
 * implementation base authority. Covers direct state writers that bypass the
 * governed tool persistence path: without the frozen base, the subsequent
 * implementation review has no bindable repository evidence authority.
 */
export function assertImplementationEntryFrozen(state: SessionState): void {
  if (state.phase === 'IMPLEMENTATION' && state.implementationBaseAuthority === undefined) {
    throw new ImplementationBaseAuthorityError(
      'Refusing to persist an IMPLEMENTATION-phase state without a frozen ' +
        'implementation base authority: no bindable repository evidence ' +
        'authority exists for the subsequent implementation review.',
    );
  }
}
