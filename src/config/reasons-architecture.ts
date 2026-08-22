/**
 * Reason codes: architecture flow (ADR submission, review loop, approval gates).
 * P10c: extracted from reasons-precondition.ts by domain.
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons-types.js';

export const ARCHITECTURE_REASONS: readonly BlockedReason[] = [
  {
    code: 'NO_ARCHITECTURE',
    category: 'precondition',
    messageTemplate: 'No ADR exists to review.',
    recoverySteps: ['Submit an ADR via flowguard_architecture with title and adrText first'],
    quickFixCommand: '/architecture',
  },

  {
    code: 'INVALID_ARCHITECTURE_TOOL_SEQUENCE',
    category: 'precondition',
    messageTemplate:
      'Invalid flowguard_architecture call sequence: ADR submission and review verdict inputs must be separate calls.',
    recoverySteps: [
      'Submit the ADR first with flowguard_architecture({ title, adrText, claims }) — no verdict inputs',
      'Do not include reviewVerdict in the ADR submission call',
      'During an active ADR review loop, submit only reviewVerdict and revised adrText when changes are requested',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ADR_SUBMISSION_MIXED_INPUTS',
    category: 'precondition',
    messageTemplate:
      'ADR submission included a review verdict. Submission and verdict are separate calls.',
    recoverySteps: [
      'Submit the ADR with flowguard_architecture({ title, adrText, claims }) — no verdict inputs',
      'Submit the review verdict separately: flowguard_architecture({ reviewVerdict })',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ADR_APPROVE_WITH_TEXT',
    category: 'precondition',
    messageTemplate:
      'ADR approval included adrText (you sent reviewVerdict="{receivedVerdict}"). Approval and ADR submission must be separate calls; adrText is for initial submissions and revisions only.',
    recoverySteps: [
      'For approval: call flowguard_architecture({ reviewVerdict: "accept" }) (host-task mode) or with reviewFindings (SDK mode) — without adrText',
      'Include adrText only when reviewVerdict is "changes_requested" (revised ADR)',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ADR_FINDINGS_WITHOUT_VERDICT',
    category: 'precondition',
    messageTemplate:
      'Review findings were submitted without a verdict. Include reviewVerdict alongside reviewFindings.',
    recoverySteps: [
      'Include reviewVerdict alongside reviewFindings',
      'Call flowguard_architecture({ reviewVerdict: "accept"|"changes_requested", reviewFindings })',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ADR_REVIEW_IN_PROGRESS',
    category: 'precondition',
    messageTemplate:
      'The ADR review loop is already active. Submit a review verdict to continue it, not a new ADR.',
    recoverySteps: [
      'The review loop is active — send reviewVerdict to continue it',
      'Call flowguard_architecture({ reviewVerdict: "accept"|"changes_requested" })',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ARCHITECTURE_REVIEW_LOOP_REQUIRED',
    category: 'precondition',
    messageTemplate: 'An architecture review verdict requires an active ADR review loop.',
    recoverySteps: [
      'Submit the ADR first and wait for the architecture review loop',
      'Then submit reviewVerdict for the active ADR review loop',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ARCHITECTURE_REVIEW_COMPLETION_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'Architecture approval requires completed independent review evidence. Current review completion: {reviewCompletion}.',
    recoverySteps: [
      'Request changes to reopen the architecture review cycle',
      'Complete the independent ADR review cycle until it is reviewer_accepted or review_exhausted',
    ],
    quickFixCommand: '/review-decision changes_requested',
  },

  {
    code: 'ARCHITECTURE_REVIEW_EVIDENCE_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'Architecture approval requires bound independent-review evidence with an explicit captured reviewer verdict. reviewer_accepted demands evidence for exactly the current ADR digest; review_exhausted demands the latest real bound review evidence. Current review completion: {reviewCompletion}. Captured reviewer verdict: {capturedVerdict}.',
    recoverySteps: [
      'Reopen the review cycle with /review-decision changes_requested',
      'Complete an independent review of the current ADR revision (or let the review budget exhaust)',
      'Then re-run /review-decision approve so the certificate can bind the evidence',
    ],
    quickFixCommand: '/review-decision changes_requested',
  },

  {
    code: 'ARCHITECTURE_REVIEW_EVIDENCE_CONTRADICTS_COMPLETION',
    category: 'precondition',
    messageTemplate:
      'Architecture approval is blocked: the bound review evidence contradicts the recorded review completion. reviewCompletion: {reviewCompletion}, captured reviewer verdict: {capturedVerdict}.',
    recoverySteps: [
      'Reopen the review cycle with /review-decision changes_requested',
      'Complete an independent review whose verdict matches the recorded review completion',
      'Then re-run /review-decision approve so the certificate can bind coherent evidence',
    ],
    quickFixCommand: '/review-decision changes_requested',
  },
];
