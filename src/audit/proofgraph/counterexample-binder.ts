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

interface ClassifiedOutcome {
  readonly outcome: CounterexampleOutcome;
  readonly diagnosticCode?: AssertionBindingReasonCode;
}

function classifyClaimOutcome(
  result: ValidationResult,
  requirement: CounterexampleRequirement,
): ClassifiedOutcome {
  if (!('kind' in requirement) || requirement.kind !== 'assertion') {
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

function bindClaimCounterexamples(
  claim: {
    claimId: string;
    counterexampleRefs: readonly { kind: string; attemptId?: string }[];
    counterexampleRequirement?: CounterexampleRequirement;
  },
  state: SessionState,
  currentDigest: string,
  evaluatedAt: string,
  diagnostics: Map<string, AssertionBindingReasonCode>,
): ProofCounterexample[] {
  const results: ProofCounterexample[] = [];
  for (const ref of claim.counterexampleRefs) {
    if (ref.kind !== 'validation_attempt' || !ref.attemptId) continue;
    const attempt = state.validationAttempts.find((a) => a.attemptId === ref.attemptId);
    if (attempt === undefined || attempt.scope !== 'implementation') {
      results.push({
        claimId: claim.claimId,
        attemptId: ref.attemptId,
        checkId: 'unresolved_validation_attempt',
        scenario: `unresolved counterexample attempt ${ref.attemptId}`,
        outcome: 'not_verified',
        boundDigest: currentDigest,
        executedAt: evaluatedAt,
      });
      continue;
    }
    const requirement = claim.counterexampleRequirement;
    const classified = requirement
      ? classifyClaimOutcome(attempt.result, requirement)
      : { outcome: 'not_verified' as const };
    if (classified.diagnosticCode) {
      if (!diagnostics.has(claim.claimId)) {
        diagnostics.set(claim.claimId, classified.diagnosticCode);
      }
    }
    results.push({
      claimId: claim.claimId,
      attemptId: attempt.attemptId,
      checkId: attempt.result.checkId,
      scenario: `falsification via check '${attempt.result.checkId}'`,
      outcome: classified.outcome,
      boundDigest: attempt.implementationDigest,
      executedAt: attempt.result.executedAt,
    });
  }
  return results;
}

/**
 * Bind the counterexample references declared on a session's contract claims to
 * executed outcomes against the current implementation revision.
 */
export function bindCounterexamples(
  state: SessionState,
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
