import { describe, expect, it } from 'vitest';

import type { AssertionExtractionResult } from '../../state/evidence-validation.js';
import { formatRunCheckStatus, formatValidationDetail } from './run-check-presentation.js';

const PASSING_EXECUTION = {
  passed: true,
  timedOut: false,
  exitCode: 0,
  executionMs: 2610,
} as const;

function extractedWithSkipped(): AssertionExtractionResult {
  return {
    status: 'extracted',
    attemptId: '11111111-1111-4111-8111-111111111111',
    providerId: 'junit',
    format: 'junit_xml',
    bindingCapability: 'assertion',
    reportDigests: ['a'.repeat(64)],
    assertions: [],
    summary: {
      assertionCount: 16,
      passedCount: 15,
      failedCount: 0,
      erroredCount: 0,
      skippedCount: 1,
      suiteInfrastructureError: false,
    },
  };
}

describe('run-check presentation', () => {
  it('surfaces structured assertion skips in durable validation detail', () => {
    expect(formatValidationDetail(PASSING_EXECUTION, extractedWithSkipped())).toBe(
      'Passed (exit 0, 2610ms); assertions: 15 passed, 0 failed, 0 errored, 1 skipped',
    );
  });

  it('surfaces skips while keeping a supported check explicitly passing', () => {
    expect(
      formatRunCheckStatus(
        'test',
        {
          passed: true,
          outcome: 'supported',
          assertionExtraction: extractedWithSkipped(),
        },
        PASSING_EXECUTION,
      ),
    ).toBe("Check 'test' passed with 1 skipped assertion(s).");
  });

  it('never labels exit-zero evidence as passed when classification is blocked', () => {
    expect(
      formatRunCheckStatus(
        'test',
        {
          passed: false,
          outcome: 'blocked',
          assertionExtraction: {
            status: 'blocked',
            attemptId: '11111111-1111-4111-8111-111111111111',
            reasonCode: 'report_missing',
            reason: 'structured report missing',
          },
        },
        PASSING_EXECUTION,
      ),
    ).toBe("Check 'test' blocked.");
  });

  it('preserves process-failure and timeout status semantics', () => {
    expect(
      formatRunCheckStatus(
        'lint',
        { passed: false, outcome: 'inconclusive' },
        { ...PASSING_EXECUTION, passed: false, exitCode: 1 },
      ),
    ).toBe("Check 'lint' failed (exit 1).");
    expect(
      formatRunCheckStatus(
        'build',
        { passed: false, outcome: 'blocked' },
        { ...PASSING_EXECUTION, passed: false, timedOut: true, exitCode: 124 },
      ),
    ).toBe("Check 'build' timed out.");
  });
});
