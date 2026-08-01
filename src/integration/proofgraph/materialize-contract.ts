/**
 * @module integration/proofgraph/materialize-contract
 * @description Materialize approved-plan ProofGraph claims at implementation review.
 *
 * The plan's immutable digest plus its recorded approval are the certificate for
 * this operation. No claim text is inferred from a mutable implementation or
 * reviewer input: only declarations already bound to that exact plan digest are
 * eligible. Current implementation attempts are the sole validation evidence.
 */

import type { ProofContract, ProofContractCoverage } from '../../state/proofgraph-contract.js';
import type { SessionState } from '../../state/schema.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';

const EMPTY_CONTRACT: ProofContract = { version: 'contract.v1', claims: [] };

export type MaterializedPlanContract = {
  readonly contract: ProofContract;
  readonly coverage: readonly ProofContractCoverage[];
};

/**
 * Produce the explicit implementation-review coverage contract.
 *
 * An empty contract deliberately records that this transition had no eligible
 * approved declarations. A declaration whose current implementation evidence is
 * missing remains in the contract with its required evidence unmet.
 */
export function materializeApprovedPlanContract(state: SessionState): ProofContract {
  return materializeApprovedPlanContractResult(state).contract;
}

/** Materialize the contract and persistable causes for coverage gaps. */
export function materializeApprovedPlanContractResult(
  state: SessionState,
): MaterializedPlanContract {
  const certificate = approvedPlanCertificate(state);
  const implementationDigest = state.implementation?.digest;
  const declarations = state.plan?.claimDeclarations;
  if (!certificate || !implementationDigest || !declarations || declarations.claims.length === 0) {
    return { contract: EMPTY_CONTRACT, coverage: [] };
  }

  const attempts = state.validationAttempts.filter(
    (attempt) =>
      attempt.scope === 'implementation' && attempt.implementationDigest === implementationDigest,
  );
  const coverage: ProofContractCoverage[] = [];
  const claims = declarations.claims.map((declaration) => {
    const expectedAttempts = attempts.filter(
      (attempt) => attempt.result.checkId === declaration.expectedCheckId,
    );
    if (expectedAttempts.length === 0) {
      coverage.push({ claimId: declaration.claimId, cause: 'missing_expected_check' });
    }
    if (declaration.mutationProfile) {
      // Materialization has no artifact-verification input. Do not bind an
      // arbitrary record; the provider must resolve a verified concrete attempt.
      coverage.push({ claimId: declaration.claimId, cause: 'unverified_mutation_profile' });
    }
    const counterexampleAttempts = declaration.counterexampleCheckId
      ? attempts.filter((attempt) => attempt.result.checkId === declaration.counterexampleCheckId)
      : [];
    return {
      claimId: declaration.claimId,
      statement: declaration.statement,
      signalClass: 'fact' as const,
      critical: declaration.critical,
      provenance: {
        kind: 'canonical_authority' as const,
        authorityId: 'plan',
        digest: certificate.authorityDigest,
        approval: {
          certificateId: certificate.certificateId,
          claimDeclarationsDigest: certificate.claimDeclarationsDigest,
          decisionAttestationDigest: certificate.decisionAttestationDigest,
          declarationId: declaration.claimId,
        },
      },
      evidenceRefs: [
        ...expectedAttempts.map((attempt) => ({
          kind: 'validation_attempt' as const,
          attemptId: attempt.attemptId,
        })),
        ...(declaration.structuralSurface
          ? [{ kind: 'structural_surface' as const, surfaceId: declaration.structuralSurface }]
          : []),
      ],
      counterexampleRefs: counterexampleAttempts.map((attempt) => ({
        kind: 'validation_attempt' as const,
        attemptId: attempt.attemptId,
      })),
      // Missing expected checks and unresolved mutation profiles must remain
      // visible as required evidence, never disappear with the declaration.
      requiredEvidence: {
        positive: [
          'executed_test' as const,
          ...(declaration.structuralSurface
            ? [
                declaration.structuralSurface === 'config-defaults'
                  ? ('schema_compare' as const)
                  : ('structural_assertion' as const),
              ]
            : []),
          ...(declaration.mutationProfile ? ['fault_injection' as const] : []),
        ],
        adversarial: declaration.critical ? ['counterexample' as const] : [],
      },
    };
  });
  return { contract: { version: 'contract.v1', claims }, coverage };
}

function approvedPlanCertificate(
  state: SessionState,
): NonNullable<SessionState['plan']>['approvalCertificate'] | null {
  const plan = state.plan;
  const certificate = plan?.approvalCertificate;
  // The certificate is the PLAN_REVIEW approval. A later implementation-review
  // decision is unrelated, and a certificate for another plan digest is stale.
  if (state.phase !== 'IMPL_REVIEW' || !plan || !certificate) return null;
  if (certificate.authorityDigest !== plan.current.digest) return null;
  const declarations = plan.claimDeclarations ?? { flow: 'plan' as const, claims: [] };
  return certificate.claimDeclarationsDigest === hashText(canonicalJsonStringify(declarations))
    ? certificate
    : null;
}
