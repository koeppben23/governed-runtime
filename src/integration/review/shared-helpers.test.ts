/**
 * @module integration/review/shared-helpers.test
 * @description Tests for shared-helpers pure functions — attestation validation.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, it, expect } from 'vitest';
import {
  validatePipelineAttestation,
  REASON_MANDATE_MISSING,
  REASON_MANDATE_MISMATCH,
  REASON_UNABLE_TO_REVIEW,
} from './shared-helpers.js';

// ─── Minimal Fixtures ─────────────────────────────────────────────────────────

function fullExpected(overrides: Partial<Parameters<typeof validatePipelineAttestation>[1]> = {}) {
  return {
    obligationId: '00000000-0000-4000-8000-000000000001',
    criteriaVersion: '1.0.0',
    mandateDigest: 'mandate-digest-1',
    iteration: 0,
    planVersion: 1,
    checkReviewedBy: true,
    checkUnableToReview: false,
    ...overrides,
  };
}

function findings(overrides: Record<string, unknown> = {}) {
  return {
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    attestation: {
      toolObligationId: '00000000-0000-4000-8000-000000000001',
      iteration: 0,
      planVersion: 1,
      criteriaVersion: '1.0.0',
      mandateDigest: 'mandate-digest-1',
      reviewedBy: 'flowguard-reviewer',
    },
    ...overrides,
  };
}

// ─── validatePipelineAttestation ──────────────────────────────────────────────

describe('validatePipelineAttestation', () => {
  it('valid attestation returns { valid: true }', () => {
    expect(validatePipelineAttestation(findings(), fullExpected())).toEqual({
      valid: true,
    });
  });

  it('missing attestation returns MANDATE_MISSING', () => {
    const result = validatePipelineAttestation(findings({ attestation: null }), fullExpected());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_MANDATE_MISSING);
  });

  it('mandate digest mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(
      findings({ attestation: { ...findings().attestation!, mandateDigest: 'wrong' } }),
      fullExpected(),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });

  it('iteration mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(findings(), fullExpected({ iteration: 2 }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });

  it('reviewedBy mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(
      findings({
        attestation: { ...findings().attestation!, reviewedBy: 'wrong-agent' },
      }),
      fullExpected(),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });

  it('unable_to_review verdict with enforce flag returns UNABLE_TO_REVIEW', () => {
    const result = validatePipelineAttestation(
      findings({ overallVerdict: 'unable_to_review' }),
      fullExpected({ checkUnableToReview: true }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_UNABLE_TO_REVIEW);
  });

  it('obligationId mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(
      findings(),
      fullExpected({ obligationId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });

  it('criteriaVersion mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(
      findings(),
      fullExpected({ criteriaVersion: '9.9.9' }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });
});
