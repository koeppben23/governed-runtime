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
import type { CounterexampleRequirement } from '../../state/proofgraph.js';
import {
  hasCurrentPlanApprovalCertificate,
  normalizePlanClaimDeclaration,
  type PlanClaimDeclaration,
} from '../../state/proofgraph-approval.js';
import type { SessionState } from '../../state/schema.js';
import {
  resolveVerifiedMutationAttempt,
  resolveVerifiedMutationVerdicts,
} from './mutation-provider.js';

const EMPTY_CONTRACT: ProofContract = { version: 'contract.v1', claims: [] };

export type MaterializedPlanContract = {
  readonly contract: ProofContract;
  readonly coverage: readonly ProofContractCoverage[];
};

function resolveMutationAttempt(
  state: SessionState,
  declaration: PlanClaimDeclaration,
  implementationDigest: string,
  mutationVerdicts: Awaited<ReturnType<typeof resolveVerifiedMutationVerdicts>>,
) {
  if (!declaration.mutationProfile) return null;
  return resolveVerifiedMutationAttempt(
    state.mutationAttempts,
    declaration.mutationProfile,
    implementationDigest,
    mutationVerdicts,
  );
}

function evidenceRefs(
  expectedAttempts: SessionState['validationAttempts'],
  declaration: PlanClaimDeclaration,
  mutationAttempt: ReturnType<typeof resolveMutationAttempt>,
) {
  const refs: ProofContract['claims'][number]['evidenceRefs'][number][] = expectedAttempts.map(
    (attempt) => ({ kind: 'validation_attempt' as const, attemptId: attempt.attemptId }),
  );
  if (declaration.structuralSurface) {
    refs.push({ kind: 'structural_surface', surfaceId: declaration.structuralSurface });
  }
  if (declaration.mutationProfile && mutationAttempt) {
    refs.push({
      kind: 'mutation_attempt',
      attemptId: mutationAttempt.attemptId,
      profileId: declaration.mutationProfile,
    });
  }
  return refs;
}

function requiredEvidence(declaration: PlanClaimDeclaration) {
  const positive: NonNullable<ProofContract['claims'][number]['requiredEvidence']>['positive'] = [
    'executed_test',
  ];
  if (declaration.structuralSurface) {
    positive.push(
      declaration.structuralSurface === 'config-defaults'
        ? 'schema_compare'
        : 'structural_assertion',
    );
  }
  if (declaration.mutationProfile) positive.push('fault_injection');
  return { positive, adversarial: declaration.critical ? ['counterexample' as const] : [] };
}

/**
 * Produce the explicit implementation-review coverage contract.
 *
 * An empty contract deliberately records that this transition had no eligible
 * approved declarations. A declaration whose current implementation evidence is
 * missing remains in the contract with its required evidence unmet.
 */
export async function materializeApprovedPlanContract(
  state: SessionState,
  worktree: string,
): Promise<ProofContract> {
  return (await materializeApprovedPlanContractResult(state, worktree)).contract;
}

/** Materialize the contract and persistable causes for coverage gaps. */
export async function materializeApprovedPlanContractResult(
  state: SessionState,
  worktree: string,
): Promise<MaterializedPlanContract> {
  const certificate = validateApprovedPlanCertificate(state);
  const implementationDigest = state.implementation?.digest;
  const declarations = state.plan?.claimDeclarations;
  if (!declarations || declarations.claims.length === 0) {
    return { contract: EMPTY_CONTRACT, coverage: [{ cause: 'missing_declarations' }] };
  }
  if (certificate.kind !== 'valid') {
    return { contract: EMPTY_CONTRACT, coverage: [{ cause: certificate.cause }] };
  }
  if (!implementationDigest) {
    return { contract: EMPTY_CONTRACT, coverage: [{ cause: 'missing_implementation' }] };
  }
  const mutationVerdicts = await resolveVerifiedMutationVerdicts(worktree, state.mutationAttempts);

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
    const mutationAttempt = resolveMutationAttempt(
      state,
      declaration,
      implementationDigest,
      mutationVerdicts,
    );
    if (declaration.mutationProfile && mutationAttempt === null) {
      coverage.push({ claimId: declaration.claimId, cause: 'unverified_mutation_profile' });
    }
    const normalized = normalizePlanClaimDeclaration(declaration);
    const requirement = normalized.counterexampleRequirement;
    const counterexampleCheckId = requirement?.checkId;
    const counterexampleAttempts = counterexampleCheckId
      ? attempts.filter((attempt) => attempt.result.checkId === counterexampleCheckId)
      : [];
    return {
      claimId: declaration.claimId,
      statement: declaration.statement,
      signalClass: 'fact' as const,
      critical: declaration.critical,
      provenance: {
        kind: 'canonical_authority' as const,
        authorityId: 'plan',
        digest: certificate.certificate.authorityDigest,
        approval: {
          certificateId: certificate.certificate.certificateId,
          claimDeclarationsDigest: certificate.certificate.claimDeclarationsDigest,
          decisionAttestationDigest: certificate.certificate.decisionAttestationDigest,
          declarationId: declaration.claimId,
        },
      },
      evidenceRefs: evidenceRefs(expectedAttempts, declaration, mutationAttempt),
      counterexampleRefs: counterexampleAttempts.map((attempt) => ({
        kind: 'validation_attempt' as const,
        attemptId: attempt.attemptId,
      })),
      counterexampleRequirement: requirement,
      requiredEvidence: requiredEvidence(declaration),
    };
  });
  return { contract: { version: 'contract.v1', claims }, coverage };
}

type CertificateValidation =
  | {
      readonly kind: 'valid';
      readonly certificate: NonNullable<NonNullable<SessionState['plan']>['approvalCertificate']>;
    }
  | { readonly kind: 'invalid'; readonly cause: 'missing_certificate' | 'invalid_certificate' };

function validateApprovedPlanCertificate(state: SessionState): CertificateValidation {
  const plan = state.plan;
  const certificate = plan?.approvalCertificate;
  // The certificate is the PLAN_REVIEW approval. A later implementation-review
  // decision is unrelated, and a certificate for another plan digest is stale.
  if (!certificate) return { kind: 'invalid', cause: 'missing_certificate' };
  if (state.phase !== 'IMPL_REVIEW' || !plan) {
    return { kind: 'invalid', cause: 'invalid_certificate' };
  }
  return hasCurrentPlanApprovalCertificate(plan)
    ? { kind: 'valid', certificate }
    : { kind: 'invalid', cause: 'invalid_certificate' };
}
