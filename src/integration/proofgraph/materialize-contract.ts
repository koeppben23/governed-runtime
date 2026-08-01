/**
 * @module integration/proofgraph/materialize-contract
 * @description Materialize approved-plan ProofGraph claims at implementation review.
 *
 * The plan's immutable digest plus its recorded approval are the certificate for
 * this operation. No claim text is inferred from a mutable implementation or
 * reviewer input: only declarations already bound to that exact plan digest are
 * eligible. Current implementation attempts are the sole validation evidence.
 */

import type { ProofContract } from '../../state/proofgraph-contract.js';
import type { SessionState } from '../../state/schema.js';

const EMPTY_CONTRACT: ProofContract = { version: 'contract.v1', claims: [] };

/**
 * Produce the explicit implementation-review coverage contract.
 *
 * An empty contract deliberately records that this transition had no eligible
 * plan claims or no current implementation evidence. This prevents stale
 * declarations from a prior implementation from silently surviving the gate.
 */
export function materializeApprovedPlanContract(state: SessionState): ProofContract {
  const certificate = approvedPlanCertificate(state);
  const implementationDigest = state.implementation?.digest;
  const declarations = state.plan?.claimDeclarations;
  if (!certificate || !implementationDigest || !declarations || declarations.claims.length === 0) {
    return EMPTY_CONTRACT;
  }

  const attempts = state.validationAttempts.filter(
    (attempt) =>
      attempt.scope === 'implementation' && attempt.implementationDigest === implementationDigest,
  );
  if (attempts.length === 0) return EMPTY_CONTRACT;

  return {
    version: 'contract.v1',
    claims: declarations.claims.flatMap((declaration) => {
      const expectedAttempts = attempts.filter(
        (attempt) => attempt.result.checkId === declaration.expectedCheckId,
      );
      // A declaration without its promised current-revision check cannot become
      // an evidence-bearing claim. Do not manufacture an empty evidence ref.
      if (expectedAttempts.length === 0) return [];
      const counterexampleAttempts = declaration.counterexampleCheckId
        ? attempts.filter((attempt) => attempt.result.checkId === declaration.counterexampleCheckId)
        : [];
      return [
        {
          claimId: declaration.claimId,
          statement: declaration.statement,
          signalClass: 'fact' as const,
          critical: declaration.critical,
          provenance: {
            kind: 'canonical_authority' as const,
            authorityId: 'plan',
            digest: certificate.authorityDigest,
          },
          evidenceRefs: [
            ...expectedAttempts.map((attempt) => ({
              kind: 'validation_attempt' as const,
              attemptId: attempt.attemptId,
            })),
            ...(declaration.structuralSurface
              ? [{ kind: 'structural_surface' as const, surfaceId: declaration.structuralSurface }]
              : []),
            ...(declaration.mutationProfile
              ? [{ kind: 'mutation_profile' as const, profileId: declaration.mutationProfile }]
              : []),
          ],
          counterexampleRefs: counterexampleAttempts.map((attempt) => ({
            kind: 'validation_attempt' as const,
            attemptId: attempt.attemptId,
          })),
        },
      ];
    }),
  };
}

function approvedPlanCertificate(
  state: SessionState,
): NonNullable<SessionState['plan']>['approvalCertificate'] | null {
  const plan = state.plan;
  const certificate = plan?.approvalCertificate;
  // The certificate is the PLAN_REVIEW approval. A later implementation-review
  // decision is unrelated, and a certificate for another plan digest is stale.
  if (state.phase !== 'IMPL_REVIEW' || !plan || !certificate) return null;
  return certificate.authorityDigest === plan.current.digest ? certificate : null;
}
