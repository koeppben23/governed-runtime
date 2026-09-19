/**
 * Reason codes: review finding subject scope and reviewer evidence observation.
 *
 * Category file for the review-validation reason set. Merged into the canonical
 * `REVIEW_VALIDATION_REASONS` array by reasons-validation-review.ts so registry
 * order and contents stay identical (no parallel registry).
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons-types.js';

export const REVIEW_FINDING_VALIDATION_REASONS = [
  // ─── Review Finding Subject-Scope Enforcement ───────────────────────────

  {
    code: 'REVIEW_SUBJECT_NOT_MATERIALIZED',
    category: 'state',
    messageTemplate:
      'Peer review cannot create obligation {obligationId} because the reviewed subject was not materialized and frozen.',
    recoverySteps: [
      'Provide exactly one supported review source and resolve it successfully',
      'Do not create or continue a review obligation until immutable subject material is available',
    ],
  },

  {
    code: 'REVIEW_SUBJECT_SCOPE_UNAVAILABLE',
    category: 'state',
    messageTemplate: 'Review obligation {obligationId} has no verifiable frozen subject scope.',
    recoverySteps: [
      'Re-run the review after subject scope resolution succeeds',
      'Do not bind findings until the reviewed revision or artifact subject is frozen',
    ],
  },

  {
    code: 'REVIEW_FINDING_SUBJECT_ANCHOR_REQUIRED',
    category: 'state',
    messageTemplate:
      'Reviewer finding {findingIndex} lacks a valid structured subject anchor for obligation {obligationId}.',
    recoverySteps: [
      'Provide at least one structured subject anchor tied to the reviewed subject',
      'Keep supporting repository evidence in evidenceLocations',
    ],
  },
  {
    code: 'REVIEW_EVIDENCE_LOCATION_ESCAPES_REPOSITORY',
    category: 'state',
    messageTemplate:
      'Reviewer finding {findingIndex} has an evidence location that escapes the repository for obligation {obligationId}.',
    recoverySteps: [
      'Use evidenceLocations paths that remain below the repository root at the frozen base or head revision',
      'Remove leading or resolving parent-directory segments that escape the repository',
    ],
  },
  {
    code: 'REVIEW_EVIDENCE_LOCATION_INVALID',
    category: 'state',
    messageTemplate:
      'Reviewer finding {findingIndex} has an invalid repository evidence location for obligation {obligationId}.',
    recoverySteps: [
      'Provide evidenceLocations as repository-relative paths at the frozen base or head revision',
      'Keep the valid subject anchor tied to the reviewed subject',
    ],
  },
  {
    code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
    category: 'state',
    messageTemplate:
      'Reviewer finding {findingIndex} has no subject anchor in the frozen reviewed subject for obligation {obligationId}.',
    recoverySteps: [
      'Anchor the finding to the reviewed change or artifact section',
      'Put unrelated observations in scopeCreep instead of blockingIssues or majorRisks',
    ],
  },
  {
    code: 'REVIEW_REPOSITORY_REVISION_UNAVAILABLE',
    category: 'state',
    messageTemplate:
      'Reviewer finding {findingIndex} cites a repository revision unavailable for obligation {obligationId}.',
    recoverySteps: [
      'Use only the frozen base or head revision available to the reviewed subject',
      'Re-run the review if the required revision provenance could not be resolved',
    ],
  },
  // ─── Reviewer Evidence Observation ───────────────────────────────────────

  {
    code: 'REVIEW_EVIDENCE_NOT_OBSERVED',
    category: 'state',
    messageTemplate:
      'Reviewer finding evidenceLocations for obligation {obligationId} have no matching authoritative repository observation: {reason}. The location is structurally valid but was not observably obtained by this reviewer attempt.',
    recoverySteps: [
      'A repository evidenceLocation is admissible only when the exact frozen bytes were obtained through flowguard_observe_repository during the binding reviewer attempt',
      'This is a governance rejection (evidence_unavailable) — it is never repairable by resubmitting findings',
      'Start a fresh review attempt and cite only locations the reviewer observes through the sanctioned observation tool',
      'Do NOT substitute worktree reads, recalled content, or citations without a matching observation',
    ],
  },
  {
    code: 'REVIEW_VERDICT_EVIDENCE_MISSING',
    category: 'state',
    messageTemplate:
      'reviewVerdict submitted for obligation {obligationId} has no matching bound ReviewInvocationEvidence. A verdict cannot be accepted without captured reviewer evidence.',
    recoverySteps: [
      'Run the flowguard-reviewer subagent for the active obligation before submitting a verdict',
      'Do NOT submit a verdict without the reviewer having produced independently captured findings',
    ],
  },
  {
    code: 'REVIEW_VERDICT_MISMATCH',
    category: 'state',
    messageTemplate:
      'Submitted reviewVerdict ({provided}) does not match the captured reviewer overallVerdict ({expected}) for obligation {obligationId}.',
    recoverySteps: [
      'Submit reviewVerdict exactly matching the reviewer subagent overallVerdict',
      'Do NOT override the reviewer verdict — it is the independent reviewer result, not user approval',
      'If you disagree with the verdict, run another review iteration with revised input',
    ],
  },
  {
    code: 'INVALID_REVIEW_TOOL_SEQUENCE',
    category: 'state',
    messageTemplate:
      'Review tool invocation sequence is invalid for obligation {obligationId}: {reason}.',
    recoverySteps: [
      'Follow the review invocation sequence documented in the review instructions',
      'Do NOT submit reviewerUnavailable when a host-observed reviewer invocation already exists',
      'Submit only the reviewVerdict; the host resolves the bound structured reviewer evidence',
    ],
  },
  {
    code: 'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
    category: 'state',
    messageTemplate:
      'The reviewer child session completed without a host-owned execution provenance record. Its output cannot bind to a review obligation.',
    recoverySteps: [
      'Re-run the originating FlowGuard command to authorize a fresh reviewer dispatch',
      'Do not reuse the prior reviewer output or submit copied findings',
    ],
  },
  {
    code: 'REVIEW_DISPATCH_PERSISTENCE_FAILED',
    category: 'state',
    messageTemplate:
      'The durable reviewer dispatch could not be persisted before the host release. The reviewer was NOT executed and no evidence exists.',
    recoverySteps: [
      'Retry the originating FlowGuard command; the reviewer was not executed and no findings were produced',
      'Ensure the session state is writable and re-hydrate the session if the write lock is contended',
      'Do NOT treat this as a reviewer failure and do NOT submit fabricated findings',
    ],
  },
] as const satisfies readonly BlockedReason[];
