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
      'Initial submission: flowguard_architecture({ title, adrText, claims }) — no reviewVerdict',
      'Revision after changes_requested: flowguard_architecture({ reviewVerdict: "changes_requested", adrText, claims }) — WITHOUT title',
      'Approval: flowguard_architecture({ reviewVerdict: "accept" }) — without adrText or title',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ADR_SUBMISSION_MIXED_INPUTS',
    category: 'precondition',
    messageTemplate:
      'ADR submission metadata (title) and a review verdict must not be combined in one call. Start with title; revise or approve with a verdict.',
    recoverySteps: [
      'Initial submission: flowguard_architecture({ title, adrText, claims }) — no reviewVerdict',
      'Revision after changes_requested: flowguard_architecture({ reviewVerdict: "changes_requested", adrText, claims }) — WITHOUT title',
      'Approval: flowguard_architecture({ reviewVerdict: "accept" }) — without adrText or title',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ARCHITECTURE_CLAIM_INVALID',
    category: 'input',
    messageTemplate:
      'Architecture claim {index} is not a valid declaration: {field} — {detail}. Architecture claims carry statement, critical, authoritySectionId, and requiredReviewEvidence; plan-only fields are not accepted.',
    recoverySteps: [
      'Submit each architecture claim with statement, critical, authoritySectionId, and requiredReviewEvidence (optional: assumptions)',
      'Remove plan-only fields from architecture claims, for example claimScope, expectedCheckId, counterexampleRequirement, structuralSurface, and mutationProfile',
      'New ADR submission: if no claims are needed, omit the claims array entirely',
      'Revising an existing ADR: pass an explicit empty claims array (claims: []) to withdraw the previous declarations; omitting claims keeps them',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ADR_APPROVE_WITH_TEXT',
    category: 'precondition',
    messageTemplate:
      'ADR approval included adrText (you sent reviewVerdict="{receivedVerdict}"). Approval and ADR submission must be separate calls; adrText is for initial submissions and revisions only.',
    recoverySteps: [
      'For approval: call flowguard_architecture({ reviewVerdict: "accept" }) without adrText',
      'Include adrText only when reviewVerdict is "changes_requested" (revised ADR)',
    ],
    quickFixCommand: '/architecture',
  },

  {
    code: 'ADR_REVIEW_IN_PROGRESS',
    category: 'precondition',
    messageTemplate:
      'The ADR review loop is already active. Continue it with a verdict — approve with the verdict alone, or revise with the verdict plus the revised ADR body. Do not submit a new ADR.',
    recoverySteps: [
      'Approval: flowguard_architecture({ reviewVerdict: "accept" }) — without adrText or title',
      'Revision: flowguard_architecture({ reviewVerdict: "changes_requested", adrText, claims }) — WITHOUT title',
      'Do not resubmit a new ADR while the review loop is active',
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
