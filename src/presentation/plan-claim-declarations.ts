/** @module presentation/plan-claim-declarations */

import type { PlanClaimDeclarations } from '../state/proofgraph-approval.js';

/**
 * Evidence-role contract for claims with a counterexample requirement. States
 * what evidence binding will require later without implying that execution
 * evidence must already exist at plan-review time.
 */
export const EVIDENCE_ROLES_LINE =
  'Evidence roles: Positive and counterexample evidence must be bound to separate validation attempts with distinct attempt identities. Different check identities and overlapping underlying test suites do not imply that both evidence roles share an attempt. This independence is enforced during evidence binding; execution evidence is not required at plan-review time.';

/**
 * Render every authority-relevant plan claim field for human and reviewer review.
 * Labels name the evidence ROLE of each check (positive vs. counterexample) so a
 * reader never has to infer the role from a check id or an assertion name.
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
        ...(counterexample ? [`  - ${EVIDENCE_ROLES_LINE}`] : []),
        `  - Structural surface: ${claim.structuralSurface ?? 'none'}`,
        `  - Mutation profile: ${claim.mutationProfile ?? 'none'}`,
        `  - Risk triggers covered: ${claim.coversRiskTriggers?.join(', ') ?? 'none'}`,
      ].join('\n');
    })
    .join('\n');
}
