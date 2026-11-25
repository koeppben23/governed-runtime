/** A successful process cannot launder ambiguous structured evidence into positive proof. */
import { describe, expect, it } from 'vitest';
import { bindExecutedTestEvidence } from './executed-test-binder.js';
import { makeState, IMPL_EVIDENCE, FIXED_TIME } from '../../fixtures.js';
import { AssertionExtractionResult } from '../../state/evidence-validation.js';
import { SessionState } from '../../state/schema.js';
import { TEST_EXECUTION_OBSERVATION } from '../../state/evidence-test-constants.js';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const CLAIM = '22222222-2222-4222-8222-222222222222';

function evidence(statuses: readonly ('passed' | 'failed')[]) {
  return AssertionExtractionResult.parse({
    status: 'extracted',
    attemptId: ATTEMPT,
    providerId: 'junit',
    format: 'junit_xml',
    bindingCapability: 'assertion',
    reportDigests: ['a'.repeat(64)],
    assertions: statuses.map((status) => ({
      assertion: { providerId: 'junit', localId: 'Test#reject' },
      providerId: 'junit',
      status,
      testName: 'reject',
      ...(status === 'failed' ? { failure: { message: 'injected contradiction' } } : {}),
    })),
    summary: {
      assertionCount: statuses.length,
      passedCount: statuses.filter((s) => s === 'passed').length,
      failedCount: statuses.filter((s) => s === 'failed').length,
      erroredCount: 0,
      skippedCount: 0,
      suiteInfrastructureError: false,
    },
  });
}

function state(statuses: readonly ('passed' | 'failed')[]) {
  return SessionState.parse(
    makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      proofContract: {
        version: 'contract.v2',
        claims: [
          {
            claimId: CLAIM,
            statement: 'The state rejects null.',
            signalClass: 'fact',
            critical: true,
            claimScope: 'specific_behavior',
            provenance: null,
            evidenceRefs: [{ kind: 'validation_attempt', attemptId: ATTEMPT }],
            counterexampleRefs: [],
          },
        ],
      },
      validationAttempts: [
        {
          attemptId: ATTEMPT,
          scope: 'implementation',
          implementationId: IMPL_EVIDENCE.implementationId,
          implementationDigest: IMPL_EVIDENCE.digest,
          executionObservation: TEST_EXECUTION_OBSERVATION,
          result: {
            checkId: 'test',
            kind: 'test',
            command: 'test-command',
            passed: true,
            exitCode: 0,
            detail: 'process exited 0',
            executedAt: FIXED_TIME,
            executionMs: 1,
            outputDigest: 'b'.repeat(64),
            timedOut: false,
            outcome: 'supported',
            assertionExtraction: evidence(statuses),
          },
        },
      ],
    }),
  );
}

describe('positive assertion evidence integrity', () => {
  it.each([
    ['passed', 'failed'],
    ['failed', 'passed'],
    ['passed', 'passed'],
  ] as const)(
    'rejects schema-readable persisted exit-0/pass-true evidence containing %s/%s duplicate identity',
    (first, second) => {
      const persisted = state([first, second]);
      const before = structuredClone(persisted);
      expect(bindExecutedTestEvidence(persisted, FIXED_TIME)[0]?.status).toBe('unavailable');
      expect(persisted).toEqual(before);
    },
  );
  it('keeps a healthy unique assertion report usable', () => {
    expect(bindExecutedTestEvidence(state(['passed']), FIXED_TIME)[0]?.status).toBe('pass');
  });
});
