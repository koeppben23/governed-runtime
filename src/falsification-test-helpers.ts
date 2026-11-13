/** Explicit simulated runtime evidence for pure binders/evaluators, not live proof. */
import type { ValidationAttempt, ValidationResult } from './state/evidence-validation.js';
import {
  counterexampleRequirementDigest,
  type CounterexampleRequirement,
  type ProofCounterexample,
} from './state/proofgraph.js';

export const TEST_FALSIFICATION_VARIANT = { path: 'src/guard.ts', before: 'guard();', after: '' };

export function simulatedFalsificationBinding(
  requirement: CounterexampleRequirement,
): NonNullable<ProofCounterexample['falsification']> {
  return {
    declarationDigest: counterexampleRequirementDigest(requirement),
    controlAttemptId: '55555555-5555-4555-8555-555555555555',
    variantAttemptId: '66666666-6666-4666-8666-666666666666',
    controlSourceDigest: 'a'.repeat(64),
    variantSourceDigest: 'b'.repeat(64),
  };
}

function simulatedResult(
  result: ValidationResult,
  attemptId: string,
  passed: boolean,
): ValidationResult {
  const extraction = result.assertionExtraction;
  return {
    ...result,
    candidateId: result.candidateId ?? 'simulated-candidate',
    passed,
    exitCode: passed ? 0 : 1,
    outcome: passed ? 'supported' : 'inconclusive',
    assertionExtraction:
      extraction?.status === 'extracted'
        ? {
            ...extraction,
            attemptId,
            assertions: extraction.assertions.map((a) => ({
              ...a,
              status: passed ? 'passed' : 'failed',
            })),
            summary: {
              ...extraction.summary,
              passedCount: passed ? extraction.summary.assertionCount : 0,
              failedCount: passed ? 0 : extraction.summary.assertionCount,
              skippedCount: 0,
              erroredCount: 0,
            },
          }
        : extraction,
  };
}

export function withSimulatedFalsification(
  attempt: ValidationAttempt,
  claimId: string,
  requirement: CounterexampleRequirement,
): ValidationAttempt {
  if (attempt.scope !== 'implementation')
    throw new Error('Only implementation attempts carry variant executions');
  const binding = simulatedFalsificationBinding(requirement);
  return {
    ...attempt,
    falsifications: [
      {
        claimId,
        ...binding,
        control: simulatedResult(attempt.result, binding.controlAttemptId, true),
        variant: simulatedResult(attempt.result, binding.variantAttemptId, false),
      },
    ],
  };
}
