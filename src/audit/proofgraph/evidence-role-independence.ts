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
  | { readonly kind: 'role_collision'; readonly attemptId: string }
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
 * Results are matched by execution record: a passing positive result that
 * points at the same validation attempt as a bound counterexample is a
 * collision. When the adversarial role is engaged and a positive
 * `executed_test` pass carries no execution identity at all, independence
 * cannot be established and the claim is not verifiable.
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
  let missingExecutionIdentity = false;
  for (const result of input.providerResults) {
    if (result.status !== 'pass') continue;
    if (
      result.executionRecordId !== undefined &&
      counterexampleAttempts.has(result.executionRecordId)
    ) {
      return { kind: 'role_collision', attemptId: result.executionRecordId };
    }
    if (result.providerKind === 'executed_test' && result.executionRecordId === undefined) {
      missingExecutionIdentity = true;
    }
  }
  return missingExecutionIdentity ? { kind: 'not_verifiable' } : { kind: 'independent' };
}
