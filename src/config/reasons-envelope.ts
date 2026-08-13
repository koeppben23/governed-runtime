/**
 * Reason codes: review envelope validation (host-task capture, extraction, binding).
 *
 * Extracted from reasons-precondition.ts to stay within the 750 LOC file-size budget.
 * Re-exported by reasons-precondition.ts as part of PRECONDITION_REASONS.
 *
 * @internal — do not import directly. Use reasons.ts barrel.
 */
import type { BlockedReason } from './reasons-types.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';

export const ENVELOPE_PRECONDITION_REASONS: readonly BlockedReason[] = [
  {
    code: 'ENVELOPE_CAPTURE_FAILED',
    category: 'precondition',
    messageTemplate:
      'The reviewer Task tool completed but produced no bindable output (capture failed).',
    recoverySteps: [
      `Re-invoke the ${REVIEWER_SUBAGENT_TYPE} subagent via the Task tool`,
      'Ensure the reviewer returns structured output; verify the subagent is reachable',
    ],
  },

  {
    code: 'ENVELOPE_PAYLOAD_NOT_FOUND',
    category: 'precondition',
    messageTemplate:
      'The reviewer output did not contain extractable ReviewFindings JSON. No JSON object was found.',
    recoverySteps: [
      `Re-invoke the ${REVIEWER_SUBAGENT_TYPE} subagent`,
      'Ensure the reviewer returns ONLY the ReviewFindings JSON object with no prose, reasoning, or markdown code fences before or after it',
    ],
  },

  {
    code: 'HOST_REVIEW_CONTEXT_UNAVAILABLE',
    category: 'precondition',
    messageTemplate: `FlowGuard enforcement: host-owned review context (obligation {obligationId}) could not be materialized for the pending review. This is a structural host-context defect — a ${REVIEWER_SUBAGENT_TYPE} invocation cannot repair it.`,
    recoverySteps: [
      'Re-run the originating FlowGuard command (plan, implement, architecture, or review) to re-issue the canonical review signal carrying requiredReviewAttestation',
      `Do not re-invoke the ${REVIEWER_SUBAGENT_TYPE} Task — reviewer output cannot replace missing host attestation constants`,
    ],
  },

  {
    code: 'ENVELOPE_PAYLOAD_AMBIGUOUS',
    category: 'precondition',
    messageTemplate:
      'The reviewer output contained multiple plausible JSON candidates and no deterministic selection was possible.',
    recoverySteps: [
      `Re-invoke the ${REVIEWER_SUBAGENT_TYPE} subagent`,
      'Ensure the reviewer returns exactly one ReviewFindings JSON object without nested or extra blocks',
    ],
  },

  {
    code: 'ENVELOPE_SCHEMA_INVALID',
    category: 'precondition',
    messageTemplate: 'The reviewer output was extracted but failed schema validation: {message}',
    recoverySteps: [
      `Re-invoke the ${REVIEWER_SUBAGENT_TYPE} subagent and ensure it returns a schema-valid ReviewFindings object`,
      'Check that all required fields (iteration, planVersion, reviewMode, overallVerdict, blockingIssues, majorRisks, missingVerification, scopeCreep, unknowns, reviewedBy, reviewedAt) are present with correct types',
    ],
  },

  {
    code: 'ENVELOPE_CLIENT_REFERENCE_INVALID',
    category: 'precondition',
    messageTemplate:
      'A reviewer challenge clientReference is invalid or duplicates another within the same payload: {message}',
    recoverySteps: [
      `Re-invoke the ${REVIEWER_SUBAGENT_TYPE} subagent`,
      'Ensure each challenge has a unique, non-empty clientReference (e.g. "c1", "c2") matching /^[a-zA-Z0-9_-]+$/',
    ],
  },

  {
    code: 'ENVELOPE_DUPLICATE_CLIENT_REFERENCE',
    category: 'precondition',
    messageTemplate:
      'Duplicate clientReference "{clientReference}" in reviewer challenges. Each challenge must have a unique clientReference.',
    recoverySteps: [
      `Re-invoke the ${REVIEWER_SUBAGENT_TYPE} subagent with unique clientReference values per challenge`,
    ],
  },

  {
    code: 'ENVELOPE_SUBJECT_MISMATCH',
    category: 'precondition',
    messageTemplate:
      'The reviewer evidence is bound to subject digest {evidenceSubject} but the obligation requires {obligationSubject}. Cross-artifact evidence binding is not permitted.',
    recoverySteps: [
      `Re-invoke the ${REVIEWER_SUBAGENT_TYPE} subagent for the correct artifact`,
      'Do not reuse review evidence from a different plan version, implementation, or branch',
    ],
  },

  {
    code: 'ENVELOPE_OBLIGATION_NOT_OPEN',
    category: 'precondition',
    messageTemplate:
      'The review obligation {obligationId} is not in an open (pending) state and cannot accept new evidence.',
    recoverySteps: [
      'Verify the obligation status with flowguard_status',
      'If the obligation is already consumed, start a fresh review cycle',
    ],
  },

  {
    code: 'ENVELOPE_STALE_ATTEMPT',
    category: 'precondition',
    messageTemplate:
      'Attempt {attemptId} is stale (a newer attempt has already been bound for this obligation).',
    recoverySteps: [
      'The stale attempt is persisted for audit but cannot be bound; use the latest attempt',
      'If the bound attempt is corrupt, re-invoke the reviewer for a fresh attempt',
    ],
  },

  {
    code: 'ENVELOPE_RETRY_BUDGET_EXHAUSTED',
    category: 'precondition',
    messageTemplate:
      'Reviewer capture retry budget exhausted after {attemptCount} attempts for obligation {obligationId}.',
    recoverySteps: [
      'Inspect the diagnostic for each failed attempt to identify the root cause',
      'Run flowguard doctor to verify the plugin and reviewer subagent health',
      'If the issue is environmental (network, subagent unreachable), address it and start a fresh session',
    ],
  },

  {
    code: 'REVIEW_ASSURANCE_UNAVAILABLE',
    category: 'precondition',
    messageTemplate:
      'Review assurance state is not available. The rejection of an incoherent attempt cannot proceed without assurance to mutate.',
    recoverySteps: [
      'Ensure the session has an active review obligation with an attempt before submitting a verdict',
      'Re-run /review to create a fresh obligation and attempt',
    ],
  },

  {
    code: 'REVIEW_ATTEMPT_ID_MISSING',
    category: 'precondition',
    messageTemplate:
      'The attempt identity (attemptId) is missing from the reviewer invocation evidence. The attempt cannot be rejected.',
    recoverySteps: [
      'This is a legacy data condition; re-invoke the reviewer subagent for a fresh attempt',
      'New invocations created by the binding path automatically carry the attemptId',
    ],
  },

  {
    code: 'REVIEW_ATTEMPT_LINEAGE_UNAVAILABLE',
    category: 'precondition',
    messageTemplate:
      'Invocation {invocationId} under obligation {obligationId} has no persisted attempt lineage. The attempt-owner relationship cannot be verified.',
    recoverySteps: [
      'Re-invoke the reviewer subagent for a fresh attempt',
      'The stale invocation is retained for audit but cannot be used for attempt status changes',
    ],
  },

  {
    code: 'REVIEW_ATTEMPT_NOT_FOUND',
    category: 'precondition',
    messageTemplate:
      'Attempt {attemptId} referenced by the reviewer invocation was not found in the assurance state.',
    recoverySteps: [
      'Verify the attempt exists in the session with flowguard_status',
      'If the attempt was removed or corrupted, re-invoke the reviewer for a fresh attempt',
    ],
  },
];
