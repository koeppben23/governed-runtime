/**
 * @module protected-transition-error
 * @description Typed invariant error for misuse of a protected transition.
 *
 * The protected `EVIDENCE_REVIEW -> EXPORT_READY` approval may only be applied
 * through the sanctioned, gate-checked application. Reaching it through a
 * generic applier is an invariant violation, not a user-facing denial.
 *
 * @version v1
 */

export class ProtectedTransitionError extends Error {
  readonly code = 'PROTECTED_TRANSITION_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'ProtectedTransitionError';
  }
}
