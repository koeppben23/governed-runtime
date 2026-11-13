/** Attested sensitivity evidence is different from another green check. */
import {
  counterexampleRequirementDigest,
  type CounterexampleRequirement,
  type ProofCounterexample,
} from '../../state/proofgraph.js';
import type { FalsificationExecution } from '../../state/evidence-validation.js';
import type {
  AssertionExtractionResult,
  ValidationResult,
} from '../../state/evidence-validation.js';
import type { CounterexampleOutcome } from '../../state/proofgraph-primitives.js';

function validExtraction(
  extraction: AssertionExtractionResult | undefined,
  attemptId: string,
): boolean {
  return (
    extraction?.status === 'extracted' &&
    extraction.attemptId === attemptId &&
    !extraction.summary.suiteInfrastructureError
  );
}

function validExecutionPair(record: FalsificationExecution, checkId: string): boolean {
  return (
    record.control.candidateId !== undefined &&
    record.control.candidateId === record.variant.candidateId &&
    record.control.checkId === checkId &&
    record.variant.checkId === checkId &&
    record.control.exitCode === 0 &&
    !record.control.timedOut &&
    validExtraction(record.control.assertionExtraction, record.controlAttemptId) &&
    validExtraction(record.variant.assertionExtraction, record.variantAttemptId)
  );
}

export function matchingFalsification(
  records: readonly FalsificationExecution[],
  claimId: string,
  requirement: CounterexampleRequirement,
): FalsificationExecution | undefined {
  if (!requirement.variant) return undefined;
  const digest = counterexampleRequirementDigest(requirement);
  return records.find(
    (record) =>
      record.claimId === claimId &&
      record.declarationDigest === digest &&
      validExecutionPair(record, requirement.checkId) &&
      record.controlAttemptId !== record.variantAttemptId &&
      record.controlSourceDigest !== record.variantSourceDigest &&
      record.variantSourceDigest.length > 0,
  );
}

export function isTargetedFalsification(
  record: FalsificationExecution | undefined,
  classify: (result: ValidationResult) => CounterexampleOutcome,
): boolean {
  if (!record) return false;
  return (
    record.control.passed &&
    record.control.outcome === 'supported' &&
    !record.variant.passed &&
    record.variant.exitCode !== 0 &&
    !record.variant.timedOut &&
    record.variant.outcome === 'inconclusive' &&
    classify(record.control) === 'supported' &&
    classify(record.variant) === 'contradicted'
  );
}

export function falsificationProof(
  record: FalsificationExecution | undefined,
): Pick<ProofCounterexample, 'falsification'> {
  if (!record) return {};
  const {
    declarationDigest,
    controlAttemptId,
    variantAttemptId,
    controlSourceDigest,
    variantSourceDigest,
  } = record;
  return {
    falsification: {
      declarationDigest,
      controlAttemptId,
      variantAttemptId,
      controlSourceDigest,
      variantSourceDigest,
    },
  };
}

export function hasBoundFalsification(
  counterexample: ProofCounterexample,
  requirement: CounterexampleRequirement | undefined,
): boolean {
  const binding = counterexample.falsification;
  return (
    requirement?.variant !== undefined &&
    binding !== undefined &&
    binding.declarationDigest === counterexampleRequirementDigest(requirement) &&
    binding.controlAttemptId !== binding.variantAttemptId &&
    binding.controlSourceDigest !== binding.variantSourceDigest
  );
}
