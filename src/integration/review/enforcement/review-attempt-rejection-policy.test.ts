/**
 * @module integration/review/enforcement/review-attempt-rejection-policy.test
 * @description Canonical repairability policy for review-attempt rejection
 * reasons: output-contract defects authorize a canonical output repair;
 * governance, scope, integrity, and execution failures never do.
 *
 * The policy itself is owned by the canonical state authority
 * (src/state/review-continuation.ts); this guard pins the classification.
 */
import { describe, expect, it } from 'vitest';
import {
  REVIEW_ATTEMPT_REJECTION_POLICY,
  isCanonicallyRepairable,
} from '../../../state/review-continuation.js';
import type { ReviewAttemptRejectionReason } from '../../../state/evidence.js';

const REPAIRABLE: readonly ReviewAttemptRejectionReason[] = [
  'schema_invalid',
  'extraction_invalid',
  'attestation_invalid',
  'relation_invalid',
];

const TERMINAL: readonly ReviewAttemptRejectionReason[] = [
  'scope_invalid',
  'evidence_unavailable',
  'material_integrity_failed',
  'subject_mismatch',
  'consistency_invalid',
  'reviewer_unavailable',
  'task_failed',
];

describe('REVIEW_ATTEMPT_REJECTION_POLICY', () => {
  it('classifies exactly the output-contract reasons as repairable', () => {
    for (const reason of REPAIRABLE) {
      expect(REVIEW_ATTEMPT_REJECTION_POLICY[reason].repair).toBe('canonical_output_retry');
      expect(isCanonicallyRepairable(reason)).toBe(true);
    }
    for (const reason of TERMINAL) {
      expect(REVIEW_ATTEMPT_REJECTION_POLICY[reason].repair).toBe('none');
      expect(isCanonicallyRepairable(reason)).toBe(false);
    }
  });

  it('covers every canonical rejection reason exactly once', () => {
    const covered = [...REPAIRABLE, ...TERMINAL].sort();
    expect(Object.keys(REVIEW_ATTEMPT_REJECTION_POLICY).sort()).toEqual(covered);
  });
});
