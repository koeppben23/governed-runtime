/**
 * @module integration/review/shared-helpers.test
 * @description Tests for shared-helpers pure functions — attestation validation,
 *              policy extraction, output detection, and session context construction.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, it, expect, vi } from 'vitest';
import {
  validatePipelineAttestation,
  isStrictEnforcementEnabled,
  isOutputAlreadyBlocked,
  REASON_MANDATE_MISSING,
  REASON_MANDATE_MISMATCH,
  REASON_UNABLE_TO_REVIEW,
} from './shared-helpers.js';
import type { SessionState } from '../../state/schema.js';

vi.mock('../review/orchestrator.js', () => ({
  extractReviewContext: vi.fn(),
}));
vi.mock('../review/prompt-builders.js', () => ({
  buildPlanReviewPrompt: vi.fn(),
  buildImplReviewPrompt: vi.fn(),
  buildArchitectureReviewPrompt: vi.fn(),
  selectReviewerProfileRules: vi.fn(() => ({})),
}));
vi.mock('../review/discovery-context-loader.js', () => ({
  buildReviewDiscoveryContext: vi.fn(),
}));

vi.mock('../plugin-helpers.js', () => ({
  parseToolResult: vi.fn((output: string) => {
    try {
      const parsed = JSON.parse(output);
      return parsed;
    } catch {
      return null;
    }
  }),
}));

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
    expect(result.code).toBe(REASON_MANDATE_MISSING);
  });

  it('mandate digest mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(
      findings({ attestation: { ...findings().attestation!, mandateDigest: 'wrong' } }),
      fullExpected(),
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });

  it('iteration mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(findings(), fullExpected({ iteration: 2 }));
    expect(result.valid).toBe(false);
    expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });

  it('reviewedBy mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(
      findings({
        attestation: { ...findings().attestation!, reviewedBy: 'wrong-agent' },
      }),
      fullExpected(),
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });

  it('unable_to_review verdict with enforce flag returns UNABLE_TO_REVIEW', () => {
    const result = validatePipelineAttestation(
      findings({ overallVerdict: 'unable_to_review' }),
      fullExpected({ checkUnableToReview: true }),
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe(REASON_UNABLE_TO_REVIEW);
  });

  it('obligationId mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(
      findings(),
      fullExpected({ obligationId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' }),
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });

  it('criteriaVersion mismatch returns MANDATE_MISMATCH', () => {
    const result = validatePipelineAttestation(
      findings(),
      fullExpected({ criteriaVersion: '9.9.9' }),
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe(REASON_MANDATE_MISMATCH);
  });
});

// ─── isStrictEnforcementEnabled ───────────────────────────────────────────────

describe('isStrictEnforcementEnabled', () => {
  it('returns true when selfReview.strictEnforcement is true', () => {
    const s = {
      policySnapshot: { selfReview: { strictEnforcement: true } },
    } as unknown as SessionState;
    expect(isStrictEnforcementEnabled(s)).toBe(true);
  });

  it('returns false when selfReview is absent', () => {
    const s = { policySnapshot: {} } as unknown as SessionState;
    expect(isStrictEnforcementEnabled(s)).toBe(false);
  });

  it('returns false when strictEnforcement is false', () => {
    const s = {
      policySnapshot: { selfReview: { strictEnforcement: false } },
    } as unknown as SessionState;
    expect(isStrictEnforcementEnabled(s)).toBe(false);
  });
});

// ─── isOutputAlreadyBlocked ───────────────────────────────────────────────────

describe('isOutputAlreadyBlocked', () => {
  it('detects blocked output from result string', () => {
    expect(
      isOutputAlreadyBlocked({
        output: JSON.stringify({ error: true, code: 'TEST_CODE' }),
      }),
    ).toBe(true);
  });

  it('returns false for non-blocked output', () => {
    expect(isOutputAlreadyBlocked({ output: JSON.stringify({ error: false }) })).toBe(false);
  });

  it('returns false for non-JSON output', () => {
    expect(isOutputAlreadyBlocked({ output: 'plain text output' })).toBe(false);
  });
});
