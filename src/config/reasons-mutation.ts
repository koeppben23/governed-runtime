/**
 * Mutation-episode reason codes: host mutation dispatch provenance and the
 * append-only unknown-outcome recovery contract.
 *
 * @see src/state/evidence-mutation-episode.ts
 */

import type { BlockedReason } from './reasons-types.js';

export const MUTATION_REASONS: readonly BlockedReason[] = [
  {
    code: 'MUTATION_EPISODE_RESOLVED',
    category: 'precondition',
    messageTemplate:
      'Host mutation episode {hostCallId} was resolved as reconciled_after_unknown_outcome (basis worktree_recapture). Prior implementation evidence is unreliable.',
    recoverySteps: [
      'Re-apply the implementation work in the worktree',
      'Record the fresh evidence with /implement',
      'Re-run the checks and submit a fresh review verdict',
    ],
    quickFixCommand: '/implement',
  },
  {
    code: 'MUTATION_EPISODE_UNRESOLVED',
    category: 'precondition',
    messageTemplate:
      'Implementation is blocked while {count} authorized host mutation episode(s) lack completion outcomes.',
    recoverySteps: [
      'Wait for the authorized host tool call to complete',
      'If the host call was interrupted and its outcome can never be observed, resolve it with flowguard_reconcile_mutation_episode({ hostCallId }) and re-apply the implementation work',
    ],
  },
  {
    code: 'MUTATION_EPISODE_REPLAY_BLOCKED',
    category: 'precondition',
    messageTemplate:
      'hostCallId {hostCallId} already authorizes a host mutation dispatch for tool {toolName}. A repeated host call identity is never treated as idempotent.',
    recoverySteps: [
      'Use the outcome of the original host call',
      'If the original host call never executed, the host must supply a fresh call identity for the new dispatch',
    ],
  },
  {
    code: 'MUTATION_EPISODE_NOT_FOUND',
    category: 'precondition',
    messageTemplate:
      'No host mutation episode exists for hostCallId {hostCallId}. The episode must exist in dispatch_authorized state before it can be resolved.',
    recoverySteps: [
      'Inspect unresolved episodes with /status',
      'Only resolve episodes that actually dispatched a host mutation',
    ],
  },
  {
    code: 'MUTATION_EPISODE_ALREADY_COMPLETED',
    category: 'precondition',
    messageTemplate:
      'hostCallId {hostCallId} has a completed mutation episode with outcome {outcome}; it cannot be resolved as unknown-outcome.',
    recoverySteps: [
      'Use the recorded episode outcome',
      'Record new implementation work with a fresh host mutation dispatch',
    ],
  },
  {
    code: 'MUTATION_EPISODE_ALREADY_RESOLVED',
    category: 'precondition',
    messageTemplate:
      'hostCallId {hostCallId} already has an append-only unknown-outcome resolution; a host mutation episode can never be resolved twice.',
    recoverySteps: [
      'Proceed with the recovery contract: re-apply the implementation work and record it with /implement',
    ],
  },
  {
    code: 'MUTATION_OUTCOME_UNKNOWN_REVALIDATION_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'Implementation evidence was recorded before the unknown-outcome resolution at {resolvedAt} and is unreliable. A fresh /implement, fresh checks, and a fresh review are required.',
    recoverySteps: [
      'Re-apply the implementation work in the worktree',
      'Record the fresh evidence with /implement',
      'Re-run the checks with /check',
      'Submit a fresh review verdict afterwards',
    ],
    quickFixCommand: '/implement',
  },
];
