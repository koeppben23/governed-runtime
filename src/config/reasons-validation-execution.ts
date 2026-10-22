import type { BlockedReason } from './reasons-types.js';

export const REVIEW_EXECUTION_REASONS = [
  {
    code: 'REVIEWER_EXECUTION_TIMEOUT',
    category: 'state',
    messageTemplate:
      'The reviewer exceeded its bounded execution deadline; the host confirmed termination and the review is blocked.',
    recoverySteps: [
      'The review obligation is closed with this code. Do not invoke the reviewer Task again or start another review in this turn.',
      'Report the blocker and stop. A new review requires a new explicit review command from the user.',
    ],
  },
  {
    code: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    category: 'state',
    messageTemplate:
      'The reviewer exceeded its bounded execution deadline, but host termination or quiescence could not be confirmed.',
    recoverySteps: [
      'Do not start another reviewer Task. The exact child may still be active or the host outcome is unknown.',
      'Inspect the host session and confirm quiescence before any further review is authorized.',
      'Report the blocker; a new review requires a new explicit review command after the host state is reconciled.',
    ],
  },
  {
    code: 'REVIEW_DOSSIER_INTEGRITY_FAILED',
    category: 'state',
    messageTemplate:
      'The reviewer evidence dossier could not be projected because mandatory persisted identities are contradictory.',
    recoverySteps: [
      'Do not dispatch the reviewer. Inspect the referenced claim, candidate, attempt, and revision identities.',
      'Repair the persisted authority state or start a fresh review obligation; never fabricate missing evidence.',
    ],
  },
  {
    code: 'REVIEW_DOSSIER_BUDGET_EXCEEDED',
    category: 'state',
    messageTemplate:
      'The complete reviewer evidence dossier or canonical prompt exceeds the fixed experimental UTF-8 budget.',
    recoverySteps: [
      'Do not truncate mandatory facts or silently fall back to the baseline renderer.',
      'Inspect the reported byte count and reduce only redundant derived data before dispatch.',
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
] as const satisfies readonly BlockedReason[];
