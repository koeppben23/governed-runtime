/**
 * @module integration/proofgraph/approval-projection
 * @description Exportable projection of ProofGraph approval and materialization (#762).
 *
 * A certificate that exists only deep in session state cannot be reviewed or
 * audited. This projection surfaces the full binding chain:
 *
 *   declaration -> approval certificate -> materialized claim
 *     -> implementation revision -> executed evidence -> verification state
 *
 * It is read-only and derives nothing: every value is copied from persisted
 * state. Missing links are represented explicitly rather than omitted, so an
 * unbound or uncovered claim stays visible.
 */

import type { SessionState } from '../../state/schema.js';
import type { ProofContractCoverage } from '../../state/proofgraph-contract.js';
import type { ClaimVerificationState } from '../../state/proofgraph-primitives.js';
import {
  hasCurrentArchitectureApprovalCertificate,
  hasCurrentPlanApprovalCertificate,
} from '../../state/proofgraph-approval.js';

/** Digest binding of one human approval certificate. */
export interface ApprovalCertificateProjection {
  readonly flow: 'plan' | 'architecture';
  readonly certificateId: string;
  readonly authorityDigest: string;
  readonly claimDeclarationsDigest: string;
  readonly decisionAttestationDigest: string;
  readonly approvedAt: string;
  readonly approvedBy: string;
  /** Number of declarations bound by this certificate. */
  readonly declaredClaimCount: number;
  readonly binding: 'current' | 'stale_or_unbound';
}

/** One materialized claim and the evidence chain that backs it. */
export interface MaterializedClaimProjection {
  readonly claimId: string;
  readonly statement: string;
  readonly signalClass: string;
  readonly critical: boolean;
  /** Present once the projection has been evaluated; null before first refresh. */
  readonly verificationState: ClaimVerificationState | null;
  /** Certificate that authorized this claim, when the claim is certificate-bound. */
  readonly certificateId: string | null;
  /** Governing authority digest, when the claim has resolved provenance. */
  readonly authorityDigest: string | null;
  /** Count of digest-bound positive evidence references. */
  readonly evidenceRefCount: number;
  /** Count of digest-bound falsification references. */
  readonly counterexampleRefCount: number;
}

/** Full approval and materialization projection for status and export surfaces. */
export interface ProofApprovalProjection {
  readonly certificates: readonly ApprovalCertificateProjection[];
  /** Implementation revision the materialized claims are bound to, when recorded. */
  readonly implementationDigest: string | null;
  readonly claims: readonly MaterializedClaimProjection[];
  readonly coverageGaps: readonly ProofContractCoverage[];
}

function certificateProjection(state: SessionState): ApprovalCertificateProjection[] {
  const certificates: ApprovalCertificateProjection[] = [];
  const plan = state.plan;
  if (plan?.approvalCertificate) {
    certificates.push({
      ...plan.approvalCertificate,
      declaredClaimCount: plan.claimDeclarations?.claims.length ?? 0,
      binding: hasCurrentPlanApprovalCertificate(plan) ? 'current' : 'stale_or_unbound',
    });
  }
  const architecture = state.architecture;
  if (architecture?.approvalCertificate) {
    certificates.push({
      ...architecture.approvalCertificate,
      declaredClaimCount: architecture.claimDeclarations?.claims.length ?? 0,
      binding: hasCurrentArchitectureApprovalCertificate(architecture)
        ? 'current'
        : 'stale_or_unbound',
    });
  }
  return certificates;
}

/**
 * Project the approval and materialization chain.
 *
 * Verification state is read from the evaluated projection when present. A
 * contract claim with no evaluated counterpart reports `null` rather than
 * defaulting to a proven-looking value.
 */
export function buildProofApprovalProjection(state: SessionState): ProofApprovalProjection {
  const evaluated = new Map(
    (state.proofGraph?.claims ?? []).map((claim) => [claim.claimId, claim] as const),
  );
  const claims = (state.proofContract?.claims ?? []).map((claim) => ({
    claimId: claim.claimId,
    statement: claim.statement,
    signalClass: claim.signalClass,
    critical: claim.critical,
    verificationState: evaluated.get(claim.claimId)?.verificationState ?? null,
    certificateId:
      claim.provenance?.kind === 'canonical_authority'
        ? (claim.provenance.approval?.certificateId ?? null)
        : null,
    authorityDigest:
      claim.provenance?.kind === 'canonical_authority' ? claim.provenance.digest : null,
    evidenceRefCount: claim.evidenceRefs.length,
    counterexampleRefCount: claim.counterexampleRefs.length,
  }));

  return {
    certificates: certificateProjection(state),
    implementationDigest: state.implementation?.candidate.candidateDigest ?? null,
    claims,
    coverageGaps: state.proofContractCoverage ?? [],
  };
}
