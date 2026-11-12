/**
 * @module audit/proofgraph/evidence-role-independence
 * @description Canonical evidence-role independence check.
 *
 * One executed validation attempt must never satisfy both the positive and the
 * adversarial (counterexample) obligation of the same claim. The declaration
 * boundary rejects identical positive/counterexample check ids; this module is
 * the shared runtime authority for already-persisted contracts, so the
 * evaluator's verification state and the persisted diagnostic projection
 * cannot drift apart.
 *
 * Only `executed_test` passes carry the positive validation-attempt identity
 * (`executionRecordId`); structural/schema providers have their own identity
 * contract and are deliberately not constrained here.
 *
 * @version v1
 */

import type {
  CounterexampleRequirement,
  ProofCounterexample,
  ProofProviderResult,
} from '../../state/proofgraph.js';

/** Outcome of the evidence-role independence assessment for one claim. */
export type EvidenceRoleIndependence =
  | { readonly kind: 'independent' }
  | { readonly kind: 'role_collision' }
  | { readonly kind: 'not_verifiable' };

/**
 * Whether a declaration reuses one check for both evidence roles.
 *
 * The check is deliberately criticality-agnostic: a declared counterexample
 * requirement is adversarial evidence for every claim, because
 * materialize-contract.ts requires a counterexample whenever the declaration
 * names one.
 */
export function declaredEvidenceRolesCollide(input: {
  readonly positiveCheckId: string;
  readonly counterexampleRequirement?: CounterexampleRequirement | undefined;
}): boolean {
  const requirement = input.counterexampleRequirement;
  return requirement !== undefined && requirement.checkId === input.positiveCheckId;
}

/**
 * Assess whether a claim's positive and adversarial evidence come from
 * independent executions.
 *
 * Independence is violated when a passing positive result points at the same
 * validation attempt as a bound counterexample, or when the same check provides
 * both roles even from two distinct attempts. The controller requires an
 * independent CHECK for the counterexample; two executions of one check are not
 * two independent evidence sources.
 *
 * When the adversarial role is engaged and a positive `executed_test` pass
 * carries no execution identity at all, independence cannot be established and
 * the claim is not verifiable. Structural/schema providers are deliberately not
 * constrained here: they have their own identity contract.
 */
export function assessEvidenceRoleIndependence(input: {
  readonly counterexampleRequirement?: CounterexampleRequirement | undefined;
  readonly adversarialCounterexampleRequired: boolean;
  readonly providerResults: readonly ProofProviderResult[];
  readonly counterexamples: readonly ProofCounterexample[];
}): EvidenceRoleIndependence {
  const engaged =
    input.counterexampleRequirement !== undefined || input.adversarialCounterexampleRequired;
  if (!engaged) return { kind: 'independent' };

  const counterexampleAttempts = new Set(input.counterexamples.map((c) => c.attemptId));
  const counterexampleChecks = new Set(input.counterexamples.map((c) => c.checkId));
  let missingExecutionIdentity = false;
  for (const result of input.providerResults) {
    if (result.status !== 'pass') continue;
    if (
      result.executionRecordId !== undefined &&
      counterexampleAttempts.has(result.executionRecordId)
    ) {
      return { kind: 'role_collision' };
    }
    // The executed-test binder records the check identity as `source.stableId`
    // (stable across executions), distinct from the single-execution
    // `executionRecordId`.
    if (
      result.providerKind === 'executed_test' &&
      counterexampleChecks.has(result.source.stableId)
    ) {
      return { kind: 'role_collision' };
    }
    if (result.providerKind === 'executed_test' && result.executionRecordId === undefined) {
      missingExecutionIdentity = true;
    }
  }
  return missingExecutionIdentity ? { kind: 'not_verifiable' } : { kind: 'independent' };
}
