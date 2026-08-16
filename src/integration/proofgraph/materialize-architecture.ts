/**
 * @module integration/proofgraph/materialize-architecture
 * @description Materialize approved-ADR ProofGraph claims at architecture completion.
 *
 * Architecture claims are deliberately materialized as `derived_signal`, never as
 * `fact`:
 *
 * An ADR declaration binds to `requiredReviewEvidence` — named review coverage —
 * not to an executable check. No provider can execute "a reviewer assessed
 * section X", so an ADR claim can never reach a fresh, revision-bound pass. Were
 * it classified as `fact`, an enabled ProofGraph policy would block every
 * architecture approval permanently (see audit/proofgraph/gate.ts, which gates
 * only critical `fact` claims). That is a false block, not fail-closed safety.
 *
 * The claims therefore stay visible, attributable, and certificate-bound while
 * remaining structurally non-blocking. Making them gate requires a real
 * executable provider first — that is deliberately out of scope here.
 */

import type { ProofContract, ProofContractCoverage } from '../../state/proofgraph-contract.js';
import type { SessionState } from '../../state/schema.js';
import { emptyClaimDeclarations } from '../../state/proofgraph-approval.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';

const EMPTY_CONTRACT: ProofContract = { version: 'contract.v1', claims: [] };

export type MaterializedArchitectureContract = {
  readonly contract: ProofContract;
  readonly coverage: readonly ProofContractCoverage[];
};

type CertificateValidation =
  | {
      readonly kind: 'valid';
      readonly certificate: NonNullable<
        NonNullable<SessionState['architecture']>['approvalCertificate']
      >;
    }
  | { readonly kind: 'invalid'; readonly cause: 'missing_certificate' | 'invalid_certificate' };

function validateApprovedArchitectureCertificate(state: SessionState): CertificateValidation {
  const architecture = state.architecture;
  const certificate = architecture?.approvalCertificate;
  if (!certificate) return { kind: 'invalid', cause: 'missing_certificate' };
  // The certificate is the ARCH_REVIEW approval for this exact ADR revision.
  if (state.phase !== 'ARCH_COMPLETE' || !architecture) {
    return { kind: 'invalid', cause: 'invalid_certificate' };
  }
  if (certificate.authorityDigest !== architecture.digest) {
    return { kind: 'invalid', cause: 'invalid_certificate' };
  }
  const declarations = architecture.claimDeclarations ?? emptyClaimDeclarations('architecture');
  return certificate.claimDeclarationsDigest === hashText(canonicalJsonStringify(declarations))
    ? { kind: 'valid', certificate }
    : { kind: 'invalid', cause: 'invalid_certificate' };
}

/**
 * Produce the architecture coverage contract for an approved ADR.
 *
 * An empty contract records that this approval carried no eligible declarations
 * rather than implying coverage.
 */
export function materializeApprovedArchitectureContractResult(
  state: SessionState,
): MaterializedArchitectureContract {
  const declarations = state.architecture?.claimDeclarations;
  if (!declarations || declarations.claims.length === 0) {
    return { contract: EMPTY_CONTRACT, coverage: [{ cause: 'missing_declarations' }] };
  }
  const certificate = validateApprovedArchitectureCertificate(state);
  if (certificate.kind !== 'valid') {
    return { contract: EMPTY_CONTRACT, coverage: [{ cause: certificate.cause }] };
  }

  const claims = declarations.claims.map((declaration) => ({
    claimId: declaration.claimId,
    statement: declaration.statement,
    // Advisory by construction: no executable provider covers ADR review evidence.
    signalClass: 'derived_signal' as const,
    critical: declaration.critical,
    provenance: {
      kind: 'canonical_authority' as const,
      authorityId: 'architecture',
      digest: certificate.certificate.authorityDigest,
      approval: {
        certificateId: certificate.certificate.certificateId,
        claimDeclarationsDigest: certificate.certificate.claimDeclarationsDigest,
        decisionAttestationDigest: certificate.certificate.decisionAttestationDigest,
        declarationId: declaration.claimId,
      },
    },
    // Named review coverage is not a digest-bound executable reference, so it is
    // never presented as evidence. The claim stays UNPROVEN and advisory.
    evidenceRefs: [],
    counterexampleRefs: [],
  }));

  return { contract: { version: 'contract.v1', claims }, coverage: [] };
}
