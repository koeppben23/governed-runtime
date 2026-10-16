/** @module presentation/plan-claim-declarations */

import type { PlanClaimDeclarations } from '../state/proofgraph-approval.js';

/**
 * Render every authority-relevant plan claim field for human and reviewer review.
 * Labels name the evidence ROLE of each check (positive vs. counterexample) so a
 * reader never has to infer the role from a check id or an assertion name. The
 * shared evidence-role rule is a review criterion stated once in the task
 * contract, never repeated per claim.
 */
export function renderPlanClaimDeclarations(
  declarations: PlanClaimDeclarations | undefined,
): string {
  if (!declarations || declarations.claims.length === 0) {
    return 'No plan claim declarations recorded.';
  }
  return declarations.claims
    .map((claim) => {
      const counterexample = claim.counterexampleRequirement;
      const counterexampleText = !counterexample
        ? 'none'
        : 'assertion' in counterexample
          ? `${counterexample.checkId}; assertion providerId: ${counterexample.assertion.providerId}; localId: ${counterexample.assertion.localId}`
          : `${counterexample.checkId}; aggregate candidateId: ${counterexample.candidateId ?? 'any'}`;
      return [
        `- **${claim.claimId}** (${claim.critical ? 'critical' : 'non-critical'})`,
        `  - Statement: ${claim.statement}`,
        `  - Authority section: ${claim.authoritySectionId}`,
        `  - Claim scope: ${claim.claimScope}`,
        `  - Positive evidence check: ${claim.expectedCheckId}`,
        `  - Counterexample (adversarial) check: ${counterexampleText}`,
        `  - Structural surface: ${claim.structuralSurface ?? 'none'}`,
        `  - Mutation profile: ${claim.mutationProfile ?? 'none'}`,
        `  - Risk triggers covered: ${claim.coversRiskTriggers?.join(', ') ?? 'none'}`,
      ].join('\n');
    })
    .join('\n');
}
