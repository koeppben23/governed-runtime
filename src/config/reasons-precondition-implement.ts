/**
 * Reason codes: implementation-phase preconditions.
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons-types.js';

export const IMPLEMENT_PRECONDITION_REASONS: readonly BlockedReason[] = [
  {
    code: 'IMPLEMENTATION_EVIDENCE_EMPTY',
    category: 'precondition',
    messageTemplate:
      'No changed files were detected in the worktree. Implementation cannot proceed without evidence.',
    recoverySteps: [
      'Make implementation changes in the worktree before calling /implement',
      'Verify that git detects your changes (git status shows modified files)',
      'If you have already made changes, ensure the worktree directory is correct',
    ],
    quickFixCommand: '/implement',
  },

  {
    code: 'IMPLEMENTATION_CANDIDATE_CHANGED_DURING_CAPTURE',
    category: 'precondition',
    messageTemplate:
      'The implementation candidate changed while it was being captured. Repository contents were modified between candidate resolution and evidence persistence.',
    recoverySteps: [
      'Run /implement again to capture the current candidate',
      'Avoid modifying files in the worktree while /implement is recording evidence',
    ],
    quickFixCommand: '/implement',
  },

  {
    code: 'IMPLEMENT_REVIEW_LOOP_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'An implementation review verdict requires an active implementation review loop, but the current phase is {phase}.',
    recoverySteps: [
      'Run the required post-implementation validation with flowguard_run_check({ kind }) for every active check',
      'After all checks pass and phase becomes IMPL_REVIEW, submit the verdict with flowguard_review_implementation({ reviewVerdict }) (in host-task mode the plugin resolves reviewFindings automatically)',
    ],
    quickFixCommand: '/check',
  },

  {
    code: 'IMPLEMENTATION_CHALLENGE_UNKNOWN',
    category: 'precondition',
    messageTemplate:
      'Implementation challenge {challengeId} is not present in prior implementation review findings.',
    recoverySteps: ['Use a challengeId from persisted implementation review findings.'],
  },
  {
    code: 'IMPLEMENTATION_CHALLENGE_ALREADY_RESOLVED',
    category: 'precondition',
    messageTemplate:
      'Implementation challenge {challengeId} already has advisory resolution evidence for the current implementation digest.',
    recoverySteps: [
      'Do not resubmit the same resolution; record a new resolution only after a further implementation change produces a new digest and fresh passing validation attempts.',
    ],
  },
  {
    code: 'IMPLEMENTATION_CHALLENGE_NOT_FAILED',
    category: 'precondition',
    messageTemplate:
      'Implementation challenge {challengeId} has outcome {outcome}; only a failed falsification (fail or not_verified) can be resolved.',
    recoverySteps: [
      'Record resolutions only for challenges the reviewer marked fail or not_verified.',
    ],
  },
  {
    code: 'IMPLEMENTATION_VALIDATION_ATTEMPT_UNKNOWN',
    category: 'precondition',
    messageTemplate:
      'Validation attempt {attemptId} is not present in the immutable validation-attempt ledger.',
    recoverySteps: ['Use an attemptId returned by post-implementation flowguard_run_check.'],
  },
  {
    code: 'IMPLEMENTATION_VALIDATION_ATTEMPT_DUPLICATE',
    category: 'precondition',
    messageTemplate:
      'Validation attempt {attemptId} was supplied more than once for one challenge resolution.',
    recoverySteps: ['Supply each immutable validation attempt ID exactly once.'],
  },
  {
    code: 'IMPLEMENTATION_VALIDATION_ATTEMPT_WRONG_SCOPE',
    category: 'precondition',
    messageTemplate:
      'Validation attempt {attemptId} is not a post-implementation validation attempt.',
    recoverySteps: ['Use only validation attempts with scope "implementation".'],
  },
  {
    code: 'IMPLEMENTATION_VALIDATION_ATTEMPT_DIGEST_MISMATCH',
    category: 'precondition',
    messageTemplate:
      'Validation attempt {attemptId} is bound to a different implementation digest.',
    recoverySteps: ['Use attempts executed against the current implementation digest.'],
  },
  {
    code: 'IMPLEMENTATION_VALIDATION_ATTEMPT_FAILED',
    category: 'precondition',
    messageTemplate:
      'Validation attempt {attemptId} did not pass and cannot support a challenge resolution.',
    recoverySteps: [
      'Fix the implementation and rerun the required validation check.',
      'Use a passing post-implementation validation attempt for the current implementation digest.',
    ],
  },
];
