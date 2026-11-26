/**
 * @module integration/proofgraph/claim-resolution-projector
 * @description Canonical extraction seam: SessionState → ClaimResolutionFacts[].
 *
 * Reads the persisted ProofGraph projection and claim diagnostics from
 * SessionState, then projects each claim into a ClaimResolutionFacts.
 * Lives in integration/ because it imports from state/ and audit/ layers;
 * the presentation layer receives only the already-computed facts.
 *
 * `requiredEvidence` and `counterexampleRequirement` are projected separately
 * from their distinct canonical sources — never collapsed.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { ProofClaim } from '../../state/proofgraph.js';
import type { AssertionBindingReasonCode } from '../../state/proofgraph.js';
import type { ClaimResolutionFacts } from '../../presentation/claim-resolution.js';
import { projectClaimResolutionFacts } from '../../presentation/claim-resolution.js';
import { assessProofGraphEvidence } from '../../audit/proofgraph/evidence-integrity.js';

export function projectClaimResolutionFactsFromState(state: SessionState): ClaimResolutionFacts[] {
  const projection = assessProofGraphEvidence(state.proofGraph, {
    contract: state.proofContract,
    validationAttempts: state.validationAttempts,
    implementationDigest: state.implementation?.digest,
  }).projection;
  const claims: readonly ProofClaim[] = projection.claims;
  if (claims.length === 0) return [];

  const diagnostics: Readonly<Record<string, AssertionBindingReasonCode>> =
    projection.claimDiagnostics ?? {};

  return claims.map((claim) => {
    const bindingDiagnostic = diagnostics[claim.claimId];
    return projectClaimResolutionFacts(claim, bindingDiagnostic);
  });
}
