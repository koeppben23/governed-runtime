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
  bindingCapability: 'assertion' | 'check_only' = 'assertion',
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
      { localId: 'tests/test_user.py::test_delete', status: 'failed' },
    ]);

    const result = bindAssertionEvidence(req, extraction, 'attempt-1');

    expect(result.status).toBe('bound');
    if (result.status === 'bound') {
      expect(result.attemptId).toBe('attempt-1');
      expect(result.bindingCapability).toBe('assertion');
      expect(result.assertion.status).toBe('passed');
    }
  });

  it('provider mismatch → provider_mismatch', () => {
    const req = requirement('pytest', 'test_create');
    const extraction = extractedResult('vitest', 'vitest_json', [
      { localId: 'test_create', status: 'passed' },
    ]);

    const result = bindAssertionEvidence(req, extraction, 'a1');

    expect(result.status).toBe('provider_mismatch');
    if (result.status === 'provider_mismatch') {
      expect(result.required).toBe('pytest');
      expect(result.actual).toBe('vitest');
    }
  });

  it('assertion identity mismatch → assertion_mismatch', () => {
    const req = requirement('pytest', 'tests/test_user.py::test_create');
    const extraction = extractedResult('pytest', 'pytest_json', [
      { localId: 'tests/test_user.py::test_delete', status: 'passed' },
    ]);

    const result = bindAssertionEvidence(req, extraction, 'a1');

    expect(result.status).toBe('assertion_mismatch');
    if (result.status === 'assertion_mismatch') {
      expect(result.required.localId).toBe('tests/test_user.py::test_create');
      expect(result.found).toContain('tests/test_user.py::test_delete');
    }
  });

  it('check_only evidence → missing with check_only_evidence', () => {
    const req = requirement('vitest', 'src/math.test.ts::adds numbers');
    const extraction = extractedResult(
      'vitest',
      'vitest_json',
      [{ localId: 'src/math.test.ts::adds numbers', status: 'passed' }],
      'check_only',
    );

    const result = bindAssertionEvidence(req, extraction, 'a1');

    expect(result.status).toBe('missing');
    if (result.status === 'missing') {
      expect(result.reason).toBe('check_only_evidence');
    }
  });

  it('inconclusive extraction → missing', () => {
    const req = requirement('junit', 'com.example.Test#testFoo');
    const extraction: AssertionExtractionResult = {
      status: 'inconclusive',
      attemptId: 'a1',
      reasonCode: 'parse_failed',
      reason: 'malformed JSON',
    };

    const result = bindAssertionEvidence(req, extraction, 'a1');

    expect(result.status).toBe('missing');
    if (result.status === 'missing') {
      expect(result.reason).toBe('evidence_missing');
    }
  });

  it('blocked extraction → missing', () => {
    const req = requirement('junit', 'com.example.Test#testFoo');
    const extraction: AssertionExtractionResult = {
      status: 'blocked',
      attemptId: 'a1',
      reasonCode: 'report_missing',
      reason: 'file not found',
    };

    const result = bindAssertionEvidence(req, extraction, 'a1');

    expect(result.status).toBe('missing');
    if (result.status === 'missing') {
      expect(result.reason).toBe('evidence_missing');
    }
  });

  it('not_configured → missing', () => {
    const req = requirement('junit', 'com.example.Test#testFoo');
    const extraction: AssertionExtractionResult = { status: 'not_configured' };

    const result = bindAssertionEvidence(req, extraction, 'a1');

    expect(result.status).toBe('missing');
  });

  it('identical localId different provider → provider_mismatch', () => {
    const req = requirement('pytest', 'test_foo');
    const extraction = extractedResult('jest', 'jest_json', [
      { localId: 'test_foo', status: 'passed', providerId: 'jest' },
    ]);

    const result = bindAssertionEvidence(req, extraction, 'a1');

    expect(result.status).toBe('provider_mismatch');
  });

  it('skipped assertion → bound but not contradicted', () => {
    const req = requirement('junit', 'com.example.Test#testSkipped');
    const extraction = extractedResult('junit', 'junit_xml', [
      { localId: 'com.example.Test#testSkipped', status: 'skipped' },
    ]);

    const result = bindAssertionEvidence(req, extraction, 'a1');

    expect(result.status).toBe('bound');
    if (result.status === 'bound') {
      expect(result.assertion.status).toBe('skipped');
    }
  });

  it('errored assertion → bound', () => {
    const req = requirement('junit', 'com.example.Test#testError');
    const extraction = extractedResult('junit', 'junit_xml', [
      { localId: 'com.example.Test#testError', status: 'errored' },
    ]);

    const result = bindAssertionEvidence(req, extraction, 'a1');

    expect(result.status).toBe('bound');
    if (result.status === 'bound') {
      expect(result.assertion.status).toBe('errored');
    }
  });
});
