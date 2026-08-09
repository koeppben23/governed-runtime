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

export function projectClaimResolutionFactsFromState(state: SessionState): ClaimResolutionFacts[] {
  const claims: readonly ProofClaim[] = state.proofGraph?.claims ?? [];
  if (claims.length === 0) return [];

  const diagnostics: Readonly<Record<string, AssertionBindingReasonCode>> =
    state.proofGraph?.claimDiagnostics ?? {};

  return claims.map((claim) => {
    const bindingDiagnostic = diagnostics[claim.claimId];
    return projectClaimResolutionFacts(claim, bindingDiagnostic);
  });
}
