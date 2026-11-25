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
import { planApprovalContextOf } from '../../state/proofgraph-approval-context.js';
import type { ReviewBinding } from '../../state/proofgraph-approval.js';
import { claimOccurrences } from '../../state/proofgraph-claim-set.js';
import { assessProofGraphEvidence } from '../../audit/proofgraph/evidence-integrity.js';

/** Digest binding of one human approval certificate. */
export interface ApprovalCertificateProjection {
  readonly flow: 'plan' | 'architecture';
  readonly certificateId: string;
  readonly authorityDigest: string;
  readonly claimDeclarationsDigest: string;
  readonly decisionAttestationDigest: string;
  readonly approvedAt: string;
  /** Explicit-decision actor id; null for a policy-automatic approval (no person exists). */
  readonly approvedBy: string | null;
  /** Number of declarations bound by this certificate. */
  readonly declaredClaimCount: number;
  readonly binding: 'current' | 'stale_or_unbound';
  /**
   * Architecture provenance edge (architecture certificates only): the exact
   * review evidence the approval rests on, or the explicit exhaustion
   * override. Plan certificates use the nullable reviewObligationId /
   * reviewEvidenceDigest fields instead.
   */
  readonly reviewBinding?: ReviewBinding;
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

function bindingStatus(current: boolean): 'current' | 'stale_or_unbound' {
  return current ? 'current' : 'stale_or_unbound';
}

function planCertificateProjection(state: SessionState): ApprovalCertificateProjection | null {
  const plan = state.plan;
  const certificate = plan?.approvalCertificate;
  if (!certificate || !plan) return null;
  const attestation = certificate.approvalAttestation;
  return {
    ...certificate,
    // A malformed in-memory certificate never fabricates an approver; the
    // binding status below still reports the certificate as unbound.
    approvedBy:
      attestation?.kind === 'explicit_decision'
        ? attestation.decision.decisionIdentity.actorId
        : null,
    declaredClaimCount: plan.claimDeclarations?.claims.length ?? 0,
    binding: bindingStatus(
      hasCurrentPlanApprovalCertificate(
        {
          current: plan.current,
          ...(plan.claimDeclarations !== undefined
            ? { claimDeclarations: plan.claimDeclarations }
            : {}),
          approvalCertificate: certificate,
        },
        planApprovalContextOf(state),
      ),
    ),
  };
}

function architectureCertificateProjection(
  architecture: SessionState['architecture'],
): ApprovalCertificateProjection | null {
  const certificate = architecture?.approvalCertificate;
  if (!certificate || !architecture) return null;
  return {
    ...certificate,
    declaredClaimCount: architecture.claimDeclarations?.claims.length ?? 0,
    binding: bindingStatus(
      hasCurrentArchitectureApprovalCertificate({
        digest: architecture.digest,
        ...(architecture.claimDeclarations !== undefined
          ? { claimDeclarations: architecture.claimDeclarations }
          : {}),
        approvalCertificate: certificate,
      }),
    ),
  };
}

function certificateProjection(state: SessionState): ApprovalCertificateProjection[] {
  const certificates: ApprovalCertificateProjection[] = [];
  const planProjection = planCertificateProjection(state);
  if (planProjection) certificates.push(planProjection);
  const architectureProjection = architectureCertificateProjection(state.architecture);
  if (architectureProjection) certificates.push(architectureProjection);
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
  const projection = assessProofGraphEvidence(state.proofGraph, {
    contract: state.proofContract,
    validationAttempts: state.validationAttempts,
    implementationDigest: state.implementation?.digest,
  }).projection;
  const occurrences = claimOccurrences(projection.claims);
  const sourceOccurrences = claimOccurrences(state.proofContract?.claims ?? []);
  const evaluated = new Map(projection.claims.map((claim) => [claim.claimId, claim] as const));
  const claims = (state.proofContract?.claims ?? []).map((claim) => ({
    claimId: claim.claimId,
    statement: claim.statement,
    signalClass: claim.signalClass,
    critical: claim.critical,
    verificationState:
      occurrences.get(claim.claimId) === 1 && sourceOccurrences.get(claim.claimId) === 1
        ? (evaluated.get(claim.claimId)?.verificationState ?? null)
        : null,
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
    implementationDigest: state.implementation?.digest ?? null,
    claims,
    coverageGaps: state.proofContractCoverage ?? [],
  };
}
