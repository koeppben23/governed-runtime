/**
 * @module config/reasons-plan-preflight
 * @description Structural plan preflight reason codes.
 *
 * These codes describe incomplete declarations and identity/coverage failures.
 * They never assert that a finding was semantically resolved, a requirement was
 * preserved, or a falsification succeeded.
 */
import type { BlockedReason } from './reasons-types.js';

export const PLAN_PREFLIGHT_REASONS: readonly BlockedReason[] = [
  {
    code: 'PLAN_EVIDENCE_DESIGN_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'The plan declares critical claims without a complete flowguard-evidence-design block. {detail}',
    recoverySteps: [
      'Add one flowguard-evidence-design entry per critical claim with the exact authoritySectionId and statement.',
      'Name the positive observable, concrete faulty variant, expected check failure and the active counterexample candidateId in executionRoute.',
      'Resubmit the complete plan; no plan version or review obligation was created.',
    ],
  },
  {
    code: 'PLAN_EVIDENCE_DESIGN_INVALID',
    category: 'precondition',
    messageTemplate: 'The flowguard-evidence-design block is structurally invalid. {detail}',
    recoverySteps: [
      'Correct the referenced field and resubmit the complete plan.',
      'Do not claim executed falsification: plan review evaluates the design, not future execution evidence.',
    ],
  },
  {
    code: 'PLAN_CLAIM_LINEAGE_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'The revision changes prior critical claims without a flowguard-claim-changes block. {detail}',
    recoverySteps: [
      'Use flowguard_status({ reviewFeedback: true }) to read planClaimAuthority and the prior critical claim identities.',
      'Declare every changed prior critical claim as retained, replaced (with one or more critical replacementClaims) or withdrawn with a rationale.',
    ],
  },
  {
    code: 'PLAN_CLAIM_LINEAGE_INVALID',
    category: 'precondition',
    messageTemplate:
      'The flowguard-claim-changes block does not match the prior critical claim authority. {detail}',
    recoverySteps: [
      'Correct the priorClaimId, replacementClaims, or disposition against the current planClaimAuthority projection.',
      'A replacement must resolve to an accepted critical claim; a withdrawn claim must be absent from the new claim set.',
    ],
  },
  {
    code: 'PLAN_CRITICAL_CLAIM_DOWNGRADE_FORBIDDEN',
    category: 'precondition',
    messageTemplate:
      'A prior critical claim remains present with critical: false. Critical scope cannot be silently downgraded. {detail}',
    recoverySteps: [
      'Keep the claim critical, or remove it and declare it withdrawn with a concrete rationale.',
      'The independent reviewer decides whether a rationalized withdrawal preserves the applicable ticket requirement.',
    ],
  },
  {
    code: 'PLAN_FINDING_RESOLUTION_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'The revision does not answer every bound blocking finding in a flowguard-finding-resolutions block. {detail}',
    recoverySteps: [
      'Read the exact bound findings and findingId values with flowguard_status({ reviewFeedback: true }).',
      'Answer every blocking finding; a reasoned clarification is valid and does not require a cosmetic edit.',
    ],
  },
  {
    code: 'PLAN_FINDING_RESOLUTION_INVALID',
    category: 'precondition',
    messageTemplate:
      'The flowguard-finding-resolutions block does not match the open review obligation. {detail}',
    recoverySteps: [
      'Bind reviewObligationId, reviewIteration and planVersion exactly to the values from reviewFeedback.',
      'Cover every blocking finding exactly once; do not reference findings from another review.',
    ],
  },
  {
    code: 'PLAN_REVIEW_FEEDBACK_UNAVAILABLE',
    category: 'precondition',
    messageTemplate:
      'The bound plan review findings do not expose the host-minted identities required for a revision response. {detail}',
    recoverySteps: [
      'Read the exact open review with flowguard_status({ reviewFeedback: true }).',
      'If the review is not open and bound, complete the required review lifecycle action before submitting a revision; never reconstruct findings from the transcript.',
    ],
  },
];
