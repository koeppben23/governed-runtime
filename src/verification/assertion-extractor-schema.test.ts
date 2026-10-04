/**
 * Tests for PR 6 schema invariants: provider consistency, check_only assertions.
 */
import { describe, expect, it } from 'vitest';
import {
  StructuredAssertionEvidence,
  AssertionExtractionResult,
  type AssertionExtractionReasonCode,
} from '../state/evidence-validation.js';

const EXTRACTED_BASE = {
  status: 'extracted' as const,
  attemptId: '00000000-0000-4000-8000-000000000001',
  providerId: 'junit' as const,
  format: 'junit_xml' as const,
  bindingCapability: 'assertion' as const,
  reportDigests: ['aaaa'.repeat(16)],
  assertions: [],
  summary: {
    assertionCount: 0,
    passedCount: 0,
    failedCount: 0,
    erroredCount: 0,
    skippedCount: 0,
    suiteInfrastructureError: false,
  },
} as const;

const ASSERTION = {
  assertion: { providerId: 'junit' as const, localId: 'Test#m' },
  providerId: 'junit' as const,
  status: 'passed' as const,
  testName: 'm',
};

describe('extracted result schema invariants', () => {
  it('accepts valid assertion-level extraction', () => {
    expect(() =>
      AssertionExtractionResult.parse({
        ...EXTRACTED_BASE,
        bindingCapability: 'assertion',
        assertions: [ASSERTION],
        summary: { ...EXTRACTED_BASE.summary, assertionCount: 1, passedCount: 1 },
      }),
    ).not.toThrow();
  });

  it('rejects check_only with non-empty assertions', () => {
    expect(() =>
      AssertionExtractionResult.parse({
        ...EXTRACTED_BASE,
        bindingCapability: 'check_only',
        assertions: [ASSERTION],
      }),
    ).toThrow();
  });

  it('accepts check_only with empty assertions', () => {
    expect(() =>
      AssertionExtractionResult.parse({
        ...EXTRACTED_BASE,
        bindingCapability: 'check_only',
        assertions: [],
      }),
    ).not.toThrow();
  });

  it('rejects mismatched extraction providerId vs assertion providerId', () => {
    expect(() =>
      AssertionExtractionResult.parse({
        ...EXTRACTED_BASE,
        providerId: 'junit',
        assertions: [{ ...ASSERTION, providerId: 'pytest' }],
        summary: { ...EXTRACTED_BASE.summary, assertionCount: 1 },
      }),
    ).toThrow();
  });
});

describe('StructuredAssertionEvidence schema invariants', () => {
  it('rejects evidence where providerId differs from assertion.providerId', () => {
    expect(() =>
      StructuredAssertionEvidence.parse({
        ...ASSERTION,
        providerId: 'pytest',
        assertion: { providerId: 'junit', localId: 'Test#m' },
      }),
    ).toThrow();
  });

  it('accepts evidence where providerId matches assertion.providerId', () => {
    expect(() =>
      StructuredAssertionEvidence.parse({
        ...ASSERTION,
        providerId: 'junit',
        assertion: { providerId: 'junit', localId: 'Test#m' },
      }),
    ).not.toThrow();
  });
});

describe('blocked/inconclusive reason codes', () => {
  it('blocked requires a valid reasonCode', () => {
    expect(() =>
      AssertionExtractionResult.parse({
        status: 'blocked',
        attemptId: '00000000-0000-4000-8000-000000000001',
        reasonCode: 'report_missing',
        reason: 'no reports found',
      }),
    ).not.toThrow();
  });

  it('blocked rejects invalid reasonCode', () => {
    expect(() =>
      AssertionExtractionResult.parse({
        status: 'blocked',
        attemptId: '00000000-0000-4000-8000-000000000001',
        reasonCode: 'INVALID_CODE',
        reason: 'bad',
      }),
    ).toThrow();
  });
});

describe('attemptId is preserved through extraction', () => {
  it('extracted result carries a valid UUID attemptId', () => {
    const AID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const result = {
      status: 'extracted' as const,
      attemptId: AID,
      providerId: 'junit' as const,
      format: 'junit_xml' as const,
      bindingCapability: 'assertion' as const,
      reportDigests: ['aaaa'.repeat(16)],
      assertions: [
        {
          assertion: { providerId: 'junit' as const, localId: 'Test#m' },
          providerId: 'junit' as const,
          status: 'passed' as const,
          testName: 'm',
        },
      ],
      summary: {
        assertionCount: 1,
        passedCount: 1,
        failedCount: 0,
        erroredCount: 0,
        skippedCount: 0,
        suiteInfrastructureError: false,
      },
    };
    const parsed = AssertionExtractionResult.parse(result);
    expect(parsed.status).toBe('extracted');
    if (parsed.status === 'extracted') {
      expect(parsed.attemptId).toBe(AID);
      expect(parsed.attemptId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });
});
