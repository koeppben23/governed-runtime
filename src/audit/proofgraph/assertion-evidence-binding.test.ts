/**
 * @module audit/proofgraph/assertion-evidence-binding.test
 * @description Tests for assertion evidence binding decisions.
 */

import { describe, expect, it } from 'vitest';
import { bindAssertionEvidence } from './assertion-evidence-binding.js';
import type { CounterexampleRequirement } from '../../state/proofgraph.js';
import type { AssertionExtractionResult } from '../../state/evidence-validation.js';

function requirement(providerId: string, localId: string): CounterexampleRequirement {
  return {
    checkId: 'test',
    assertion: { providerId, localId },
  };
}

function extractedResult(
  providerId: string,
  format: string,
  assertions: Array<{ localId: string; status: string; providerId?: string }>,
  bindingCapability: 'assertion' | 'aggregate' | 'check_only' = 'assertion',
): AssertionExtractionResult {
  return {
    status: 'extracted',
    attemptId: 'attempt-1',
    providerId,
    format: format as never,
    bindingCapability,
    reportDigests: ['abc123'],
    assertions: assertions.map((a) => ({
      assertion: { providerId: a.providerId ?? providerId, localId: a.localId },
      providerId: a.providerId ?? providerId,
      status: a.status as 'passed' | 'failed' | 'errored' | 'skipped',
      testName: a.localId,
    })),
    summary: {
      assertionCount: assertions.length,
      passedCount: assertions.filter((a) => a.status === 'passed').length,
      failedCount: assertions.filter((a) => a.status === 'failed').length,
      erroredCount: assertions.filter((a) => a.status === 'errored').length,
      skippedCount: assertions.filter((a) => a.status === 'skipped').length,
      suiteInfrastructureError: false,
    },
  };
}

describe('bindAssertionEvidence', () => {
  it('exact match → bound', () => {
    const req = requirement('pytest', 'tests/test_user.py::test_create');
    const extraction = extractedResult('pytest', 'pytest_json', [
      { localId: 'tests/test_user.py::test_create', status: 'passed' },
    ]);

    const result = bindAssertionEvidence({
      requirement: req,
      checkId: 'test',
      extraction,
    });

    expect(result.status).toBe('bound');
    if (result.status === 'bound') {
      expect(result.attemptId).toBe('attempt-1');
      expect(result.assertion.status).toBe('passed');
    }
  });

  it('check mismatch → rejected with check_mismatch', () => {
    const req = requirement('junit', 'com.example.Test#testFoo');
    const extraction = extractedResult('junit', 'junit_xml', [
      { localId: 'com.example.Test#testFoo', status: 'passed' },
    ]);

    const result = bindAssertionEvidence({
      requirement: req,
      checkId: 'wrong-check',
      extraction,
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reasonCode).toBe('check_mismatch');
    }
  });

  it('provider mismatch → rejected with provider_mismatch', () => {
    const req = requirement('pytest', 'test_create');
    const extraction = extractedResult('vitest', 'vitest_json', [
      { localId: 'test_create', status: 'passed' },
    ]);

    const result = bindAssertionEvidence({
      requirement: req,
      checkId: 'test',
      extraction,
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reasonCode).toBe('provider_mismatch');
    }
  });

  it('assertion identity mismatch → rejected with assertion_mismatch', () => {
    const req = requirement('pytest', 'tests/test_user.py::test_create');
    const extraction = extractedResult('pytest', 'pytest_json', [
      { localId: 'tests/test_user.py::test_delete', status: 'passed' },
    ]);

    const result = bindAssertionEvidence({
      requirement: req,
      checkId: 'test',
      extraction,
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reasonCode).toBe('assertion_mismatch');
    }
  });

  it('check_only evidence → rejected with check_only_evidence', () => {
    const req = requirement('vitest', 'src/math.test.ts::adds numbers');
    const extraction = extractedResult(
      'vitest',
      'vitest_json',
      [{ localId: 'src/math.test.ts::adds numbers', status: 'passed' }],
      'check_only',
    );

    const result = bindAssertionEvidence({
      requirement: req,
      checkId: 'test',
      extraction,
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reasonCode).toBe('check_only_evidence');
    }
  });

  it('aggregate evidence → rejected with check_only_evidence', () => {
    const req = requirement('pytest', 'tests/test_user.py::test_create');
    const extraction = extractedResult(
      'pytest',
      'junit_xml',
      [{ localId: 'tests/test_user.py::test_create', status: 'passed' }],
      'aggregate',
    );

    const result = bindAssertionEvidence({
      requirement: req,
      checkId: 'test',
      extraction,
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reasonCode).toBe('check_only_evidence');
    }
  });

  it('inconclusive extraction → rejected with evidence_missing', () => {
    const req = requirement('junit', 'com.example.Test#testFoo');
    const extraction: AssertionExtractionResult = {
      status: 'inconclusive',
      attemptId: 'a1',
      reasonCode: 'parse_failed',
      reason: 'malformed JSON',
    };

    const result = bindAssertionEvidence({
      requirement: req,
      checkId: 'test',
      extraction,
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reasonCode).toBe('evidence_missing');
    }
  });

  it('blocked extraction → rejected with evidence_missing', () => {
    const req = requirement('junit', 'com.example.Test#testFoo');
    const extraction: AssertionExtractionResult = {
      status: 'blocked',
      attemptId: 'a1',
      reasonCode: 'report_missing',
      reason: 'file not found',
    };

    const result = bindAssertionEvidence({
      requirement: req,
      checkId: 'test',
      extraction,
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reasonCode).toBe('evidence_missing');
    }
  });

  it('not_configured → rejected with evidence_missing', () => {
    const req = requirement('junit', 'com.example.Test#testFoo');
    const extraction: AssertionExtractionResult = { status: 'not_configured' };

    const result = bindAssertionEvidence({
      requirement: req,
      checkId: 'test',
      extraction,
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reasonCode).toBe('evidence_missing');
    }
  });

  it('identical localId different provider → rejected with provider_mismatch', () => {
    const req = requirement('pytest', 'test_foo');
    const extraction = extractedResult('jest', 'jest_json', [
      { localId: 'test_foo', status: 'passed', providerId: 'jest' },
    ]);

    const result = bindAssertionEvidence({
      requirement: req,
      checkId: 'test',
      extraction,
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reasonCode).toBe('provider_mismatch');
    }
  });

  it('undefined extraction → rejected with evidence_missing', () => {
    const req = requirement('junit', 'com.example.Test#testFoo');

    const result = bindAssertionEvidence({
      requirement: req,
      checkId: 'test',
      extraction: undefined,
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reasonCode).toBe('evidence_missing');
    }
  });
});
