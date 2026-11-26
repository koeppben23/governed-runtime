import type { BlockedReason } from './reasons-types.js';

export const REVIEW_EXECUTION_REASONS = [
  {
    code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    category: 'state',
    messageTemplate:
      'The reviewer execution ended with an unknown outcome (interrupted, failed or unprovable); its review obligation is blocked and no evidence was bound.',
    recoverySteps: [
      'Do not start another reviewer subagent in this turn. The exact child may still be active.',
      'In a later user turn, call the originating review tool with reviewRecovery "retry_transport". FlowGuard then interrupts the stale child, proves a stable idle boundary and reopens the same frozen obligation for one fresh attempt within its budget.',
      'If the settlement cannot be proven, the obligation stays blocked; report it instead of retrying.',
    ],
  },
  {
    code: 'REVIEWER_TASK_ABORTED',
    category: 'state',
    messageTemplate:
      'The reviewer task was aborted before it completed; an aborted review is never serialized, accepted, or restarted automatically: {reason}',
    recoverySteps: [
      'If the abort was intended, no action is required: the review obligation stays unfulfilled',
      'To review again, re-run the originating FlowGuard command; it re-arms a fresh reviewer attempt on the same frozen obligation',
    ],
  },
  {
    code: 'REVIEW_CAPACITY_NOT_LOCKED',
    category: 'state',
    messageTemplate: 'No recoverable terminal reviewer capacity lock exists for this session.',
    recoverySteps: [
      'Run /status to inspect the current review and workflow state.',
      'Use the typed reviewRecovery "retry_transport" path for an unknown reviewer execution outcome.',
      'Do not invent a capacity lock or infer one from caller text.',
    ],
  },
  {
    code: 'REVIEW_CAPACITY_RECOVERY_UNSAFE',
    category: 'state',
    messageTemplate: 'The terminal reviewer capacity lock cannot be released safely: {reason}',
    recoverySteps: [
      'Keep the lock and the blocked obligation unchanged.',
      'Inspect the durable reviewer dispatch, attempt and obligation lineage with /status.',
      'Use reviewRecovery "retry_transport" for an unknown execution outcome, or EndGovernance after safe workflow closure.',
    ],
  },
] as const satisfies readonly BlockedReason[];
