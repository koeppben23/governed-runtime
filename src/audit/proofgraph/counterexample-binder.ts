/**
 * @module audit/proofgraph/counterexample-binder
 * @description Bind declared counterexample references to executed outcomes.
 *
 * Falsification-first, evidence-bound: a claim's counterexample references name
 * an implementation validation attempt whose explicit falsification or
 * verified support produces a decisive outcome:
 *   - matching structured assertion failed → contradicted
 *   - supported           → supported  (the falsification attempt did not hold)
 *   - inconclusive        → not_verified (failed but not a falsification)
 *   - blocked             → blocked (could not execute; timeout, crash, no output)
 *   - missing / wrong scope → not_verified
 *
 * @version v2 — assertion binding delegated to assertion-evidence-binding.ts,
 * diagnostics propagated for enforcement visibility.
 */

import type { SessionState } from '../../state/schema.js';
import type { ProofCounterexample, CounterexampleRequirement } from '../../state/proofgraph.js';
import type { CounterexampleOutcome } from '../../state/proofgraph-primitives.js';
import type { ValidationResult } from '../../state/evidence-validation.js';
import { bindAssertionEvidence } from './assertion-evidence-binding.js';
import type { AssertionBindingReasonCode } from './assertion-evidence-binding.js';
import {
  matchingFalsification,
  isTargetedFalsification,
  falsificationProof,
} from './falsification-binding.js';

interface ClassifiedOutcome {
  readonly outcome: CounterexampleOutcome;
  readonly diagnosticCode?: AssertionBindingReasonCode;
}

/** Exact persisted observation inputs needed for adversarial binding; no synthesized session authority. */
export type CounterexampleBindingState = Pick<
  SessionState,
  'proofContract' | 'validationAttempts'
> & {
  readonly implementation: { readonly digest: string } | null;
};

function classifyAggregateOutcome(
  result: ValidationResult,
  requirement: Extract<CounterexampleRequirement, { kind: 'aggregate_check' }>,
): ClassifiedOutcome {
  const extraction = result.assertionExtraction;
  if (result.checkId !== requirement.checkId)
    return { outcome: 'not_verified', diagnosticCode: 'aggregate_check_mismatch' };
  if (requirement.candidateId !== undefined && result.candidateId !== requirement.candidateId)
    return { outcome: 'not_verified', diagnosticCode: 'aggregate_candidate_mismatch' };
  if (result.fullCheckScopeAttestation !== 'full_check')
    return { outcome: 'not_verified', diagnosticCode: 'aggregate_scope_unattested' };
  if (extraction?.status !== 'extracted')
    return { outcome: 'not_verified', diagnosticCode: 'aggregate_extraction_missing' };
  if (extraction.bindingCapability !== 'aggregate')
    return { outcome: 'not_verified', diagnosticCode: 'aggregate_capability_missing' };
  return result.passed ? { outcome: 'supported' } : { outcome: 'contradicted' };
}

function classifyClaimOutcome(
  result: ValidationResult,
  requirement: CounterexampleRequirement,
): ClassifiedOutcome {
  if ('kind' in requirement && requirement.kind === 'aggregate_check') {
    return classifyAggregateOutcome(result, requirement);
  }
  if (!('assertion' in requirement)) {
    return { outcome: 'not_verified', diagnosticCode: 'evidence_missing' };
  }
  const extraction = result.assertionExtraction;
  if (!extraction) return { outcome: 'not_verified', diagnosticCode: 'evidence_missing' };

  const binding = bindAssertionEvidence({
    requirement,
    checkId: result.checkId,
    extraction,
  });

  if (binding.status !== 'bound') {
    return { outcome: 'not_verified', diagnosticCode: binding.reasonCode };
  }

  switch (binding.assertion.status) {
    case 'failed':
      return { outcome: 'contradicted' };
    case 'passed':
      return { outcome: 'supported' };
    case 'errored':
      return { outcome: 'blocked' };
    case 'skipped':
      return { outcome: 'not_verified' };
  }
}

export interface CounterexampleBindingResult {
  readonly counterexamples: readonly ProofCounterexample[];
  readonly diagnostics: ReadonlyMap<string, AssertionBindingReasonCode>;
}

type BoundAttempt = Extract<
  CounterexampleBindingState['validationAttempts'][number],
  { scope: 'implementation' }
>;
type ClaimBinding = {
  readonly claimId: string;
  readonly counterexampleRefs: readonly { kind: string; attemptId?: string | undefined }[];
  readonly counterexampleRequirement?: CounterexampleRequirement | undefined;
};

/** A green ordinary run is not falsification; only a detected source variant is. */
function classifyWithFalsification(
  claim: ClaimBinding,
  attempt: BoundAttempt,
): {
  readonly outcome: CounterexampleOutcome;
  readonly diagnosticCode?: AssertionBindingReasonCode;
} {
  const requirement = claim.counterexampleRequirement;
  if (!requirement) return { outcome: 'not_verified' };
  const classified = classifyClaimOutcome(attempt.result, requirement);
  if (classified.outcome !== 'supported') return classified;
  const falsification = matchingFalsification(
    attempt.falsifications ?? [],
    claim.claimId,
    requirement,
  );
  const detected = isTargetedFalsification(
    falsification,
    (result) => classifyClaimOutcome(result, requirement).outcome,
  );
  return { outcome: detected ? 'supported' : 'not_verified' };
}

function unresolvedCounterexample(
  claimId: string,
  attemptId: string,
  currentDigest: string,
  evaluatedAt: string,
): ProofCounterexample {
  return {
    claimId,
    attemptId,
    checkId: 'unresolved_validation_attempt',
    scenario: `unresolved counterexample attempt ${attemptId}`,
    outcome: 'not_verified',
    boundDigest: currentDigest,
    executedAt: evaluatedAt,
  };
}

function bindClaimCounterexamples(
  claim: ClaimBinding,
  state: CounterexampleBindingState,
  currentDigest: string,
  evaluatedAt: string,
  diagnostics: Map<string, AssertionBindingReasonCode>,
): ProofCounterexample[] {
  const results: ProofCounterexample[] = [];
  for (const ref of claim.counterexampleRefs) {
    if (ref.kind !== 'validation_attempt' || !ref.attemptId) continue;
    const attempt = state.validationAttempts.find((a) => a.attemptId === ref.attemptId);
    if (attempt === undefined || attempt.scope !== 'implementation') {
      results.push(
        unresolvedCounterexample(claim.claimId, ref.attemptId, currentDigest, evaluatedAt),
      );
      continue;
    }
    const classified = classifyWithFalsification(claim, attempt);
    if (classified.diagnosticCode && !diagnostics.has(claim.claimId)) {
      diagnostics.set(claim.claimId, classified.diagnosticCode);
    }
    const requirement = claim.counterexampleRequirement;
    const falsification = requirement
      ? matchingFalsification(attempt.falsifications ?? [], claim.claimId, requirement)
      : undefined;
    results.push({
      claimId: claim.claimId,
      attemptId: attempt.attemptId,
      checkId: attempt.result.checkId,
      scenario: falsification
        ? `isolated source variant via check '${attempt.result.checkId}'`
        : `ordinary check '${attempt.result.checkId}'; no executed source variant`,
      outcome: classified.outcome,
      boundDigest: attempt.implementationDigest,
      executedAt: attempt.result.executedAt,
      ...falsificationProof(classified.outcome === 'supported' ? falsification : undefined),
    });
  }
  return results;
}

/**
 * Bind the counterexample references declared on a session's contract claims to
 * executed outcomes against the current implementation revision.
 */
export function bindCounterexamples(
  state: CounterexampleBindingState,
  evaluatedAt: string,
): CounterexampleBindingResult {
  const claims = state.proofContract?.claims ?? [];
  const currentDigest = state.implementation?.digest;
  if (currentDigest === undefined) return { counterexamples: [], diagnostics: new Map() };

  const diagnostics = new Map<string, AssertionBindingReasonCode>();
  const counterexamples: ProofCounterexample[] = [];
  for (const claim of claims) {
    counterexamples.push(
      ...bindClaimCounterexamples(claim, state, currentDigest, evaluatedAt, diagnostics),
    );
  }
  return { counterexamples, diagnostics };
}
