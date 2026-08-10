/**
 * Reason codes: implementation approval binding preconditions.
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons-types.js';

export const IMPLEMENTATION_APPROVAL_REASONS: readonly BlockedReason[] = [
  {
    code: 'IMPLEMENTATION_CANDIDATE_STALE',
    category: 'precondition',
    messageTemplate:
      'The repository has changed since the implementation candidate was recorded. The recorded review evidence does not authorize the current repository state. Recorded candidate: {recordedCandidate}.',
    recoverySteps: [
      'Run /implement to record the current candidate',
      'Re-validate the new candidate',
      'Re-review the new candidate',
    ],
    quickFixCommand: '/implement',
  },
  {
    code: 'IMPLEMENTATION_REVIEW_BINDING_INVALID',
    category: 'precondition',
    messageTemplate:
      'No completed independent review obligation binds the current implementation candidate (candidateDigest: {candidateDigest}). The implementation must be independently reviewed at its current identity before final approval.',
    recoverySteps: [
      'Submit a review verdict via flowguard_review_implementation for the current candidate',
      'Ensure the review obligation was created for the current implementation record',
      'If the obligation is stale because the implementation was re-recorded, re-run /implement and re-review',
    ],
    quickFixCommand: '/implement',
  },
  {
    code: 'IMPLEMENTATION_VALIDATION_BINDING_INVALID',
    category: 'precondition',
    messageTemplate:
      'Not all required validation checks have passing evidence for the current implementation content. Validation evidence must be re-run against the current candidate.',
    recoverySteps: [
      'Run flowguard_run_check for each required check that has no passing evidence for the current implementation',
      'Checks without passing evidence are visible in /status output',
    ],
    quickFixCommand: '/check',
  },
  {
    code: 'IMPLEMENTATION_CANDIDATE_MISSING',
    category: 'precondition',
    messageTemplate:
      'No implementation candidate is recorded. Final approval requires candidate identity to bind the evidence chain.',
    recoverySteps: ['Run /implement to record the current implementation candidate'],
    quickFixCommand: '/implement',
  },
  {
    code: 'IMPLEMENTATION_APPROVAL_BINDING_INVALID',
    category: 'precondition',
    messageTemplate:
      'Internal state inconsistency: implementation approval cannot be validated because required state fields are missing or inconsistent.',
    recoverySteps: [
      'This is an internal error — the session state should include either an implementation candidate and approval or neither',
      'If the session is in a recovery phase, return to IMPLEMENTATION and re-record evidence',
    ],
  },
];
