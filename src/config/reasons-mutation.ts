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
    code: 'MUTATION_EPISODE_BINDING_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'Evidence approval is blocked while {count} host mutation episode(s) are unbound to implementation evidence.',
    recoverySteps: [
      'Run /request-changes to return to IMPLEMENTATION',
      'Record a fresh implementation with /implement',
      'Re-run required checks and obtain a review for the fresh implementation digest',
    ],
    quickFixCommand: '/request-changes',
  },
  {
    code: 'MUTATION_EPISODE_CONTROL_PLANE_MUTATED',
    category: 'precondition',
    messageTemplate:
      'The git control plane (.git config/hooks/HEAD) changed since the session baseline was captured. The repository effect of a host mutation is not covered by the implementation subject, so recording fails closed.',
    recoverySteps: [
      'Restore the git control plane to its baseline state',
      'Or start a fresh /hydrate session so a new baseline is established',
      'Re-apply the implementation work and record fresh evidence with /implement',
    ],
  },
  {
    code: 'MUTATION_EPISODE_CONTROL_PLANE_UNAVAILABLE',
    category: 'precondition',
    messageTemplate:
      'The git control plane (.git config/hooks/HEAD) could not be read for evidence binding. Recording fails closed because a host mutation effect cannot be verified against the baseline.',
    recoverySteps: [
      'Verify the .git directory is present and readable',
      'Restore or re-initialize the git repository, then start a fresh /hydrate session',
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
    code: 'MUTATION_EPISODE_RUNTIME_EPOCH_ACTIVE',
    category: 'precondition',
    messageTemplate:
      'hostCallId {hostCallId} is bound to lease generation {episodeLeaseGeneration}; the current lease generation is {currentLeaseGeneration}. The authorizing epoch is not provably over — the episode can only be resolved after a later lease generation has fenced the previous holder.',
    recoverySteps: [
      'Let the host call complete so its outcome can be observed',
      'If the host process died, restart the runtime so the new instance supersedes the stale lease, then resolve with flowguard_reconcile_mutation_episode({ hostCallId })',
    ],
  },
  {
    code: 'MUTATION_EPISODE_LEASE_UNAVAILABLE',
    category: 'precondition',
    messageTemplate:
      'The session is governed by another live runtime instance (lease generation {activeLeaseGeneration}); the requested recovery action cannot acquire the session lease.',
    recoverySteps: [
      'Stop the other runtime instance before operating on this session',
      'If the other instance has already died, retry — the stale lease will be fenced by a later generation',
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
