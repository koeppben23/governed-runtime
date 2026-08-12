/**
 * @module integration/review/enforcement/rejection-policy.test
 * @description Canonical rejection-reason mapping: every HostTaskBindOutcome
 *              maps deterministically, and repairability follows the policy.
 */
import { describe, expect, it } from 'vitest';
import {
  REVIEW_ATTEMPT_REJECTION_POLICY,
  bindOutcomeToRejectionReason,
  isCanonicallyRepairable,
} from './rejection-policy.js';
import type { HostTaskBindOutcome } from './types.js';

const ALL_OUTCOMES: readonly HostTaskBindOutcome[] = [
  'bound',
  'no_matched_record',
  'no_child_session',
  'no_obligation_type',
  'no_findings',
  'no_matching_obligation',
  'field_mismatch',
  'duplicate_evidence',
  'schema_invalid',
  'client_reference_invalid',
  'challenge_contract_violation',
  'challenge_evidence_unknown',
  'findings_incoherent',
  'review_finding_out_of_scope',
  'review_finding_scope_unverifiable',
  'subject_mismatch',
  'stale_attempt',
  'idempotent_bound',
  'idempotent_rejected',
  'unknown_attempt',
];

describe('bindOutcomeToRejectionReason', () => {
  it('maps every outcome without throwing', () => {
    for (const outcome of ALL_OUTCOMES) {
      expect(() => bindOutcomeToRejectionReason(outcome)).not.toThrow();
    }
  });

  it('maps output-contract outcomes to repairable reasons', () => {
    expect(bindOutcomeToRejectionReason('schema_invalid')).toBe('schema_invalid');
    expect(bindOutcomeToRejectionReason('field_mismatch')).toBe('attestation_invalid');
    expect(bindOutcomeToRejectionReason('client_reference_invalid')).toBe('relation_invalid');
    expect(bindOutcomeToRejectionReason('challenge_contract_violation')).toBe('relation_invalid');
  });

  it('maps governance outcomes to non-repairable reasons', () => {
    expect(bindOutcomeToRejectionReason('challenge_evidence_unknown')).toBe('consistency_invalid');
    expect(bindOutcomeToRejectionReason('findings_incoherent')).toBe('consistency_invalid');
    expect(bindOutcomeToRejectionReason('review_finding_out_of_scope')).toBe('scope_invalid');
    expect(bindOutcomeToRejectionReason('review_finding_scope_unverifiable')).toBe('scope_invalid');
    expect(bindOutcomeToRejectionReason('no_matching_obligation')).toBe('subject_mismatch');
    expect(bindOutcomeToRejectionReason('subject_mismatch')).toBe('material_integrity_failed');
  });

  it('maps success, environment, lifecycle, and duplicate outcomes to null', () => {
    for (const outcome of [
      'bound',
      'no_matched_record',
      'no_child_session',
      'no_obligation_type',
      'no_findings',
      'duplicate_evidence',
      'stale_attempt',
      'idempotent_bound',
      'idempotent_rejected',
      'unknown_attempt',
    ] as const) {
      expect(bindOutcomeToRejectionReason(outcome)).toBeNull();
    }
  });
});

describe('REVIEW_ATTEMPT_REJECTION_POLICY', () => {
  it('classifies exactly the output-contract reasons as repairable', () => {
    const repairable = [
      'schema_invalid',
      'extraction_invalid',
      'attestation_invalid',
      'relation_invalid',
    ];
    const terminal = [
      'scope_invalid',
      'evidence_unavailable',
      'material_integrity_failed',
      'subject_mismatch',
      'consistency_invalid',
      'reviewer_unavailable',
      'task_failed',
    ];
    for (const reason of repairable) {
      expect(
        REVIEW_ATTEMPT_REJECTION_POLICY[reason as keyof typeof REVIEW_ATTEMPT_REJECTION_POLICY]
          .repair,
      ).toBe('canonical_output_retry');
      expect(isCanonicallyRepairable(reason as keyof typeof REVIEW_ATTEMPT_REJECTION_POLICY)).toBe(
        true,
      );
    }
    for (const reason of terminal) {
      expect(
        REVIEW_ATTEMPT_REJECTION_POLICY[reason as keyof typeof REVIEW_ATTEMPT_REJECTION_POLICY]
          .repair,
      ).toBe('none');
      expect(isCanonicallyRepairable(reason as keyof typeof REVIEW_ATTEMPT_REJECTION_POLICY)).toBe(
        false,
      );
    }
  });
});
