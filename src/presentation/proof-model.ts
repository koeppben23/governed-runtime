/**
 * @module presentation/proof-model
 * @description Leaf semantic types for ProofGraph presentation.
 */

export type ClaimVerificationState =
  'PROVEN' | 'UNPROVEN' | 'CONTRADICTED' | 'STALE' | 'BLOCKED' | 'NOT_VERIFIED';

/** Graph-level state; NOT_DECLARED is never a state of an individual claim. */
export type ProofGraphPresentationStatus =
  'NOT_DECLARED' | 'AWAITING_EVIDENCE' | ClaimVerificationState;

export interface CompactProofClaim {
  readonly claimId: string;
  readonly statement: string;
  readonly status: ClaimVerificationState;
  readonly critical: boolean;
  readonly reason?: string;
  readonly recovery?: readonly string[];
}

/** Approval attestation is deliberately distinct from verification. */
export type ProofApprovalPresentation =
  | { readonly status: 'not_recorded' }
  | {
      readonly status: 'current';
      readonly flow: 'plan' | 'architecture';
      readonly certificateId: string;
    }
  | { readonly status: 'stale_or_unbound' };

export type CompactProofPresentation =
  | {
      readonly kind: 'declaration';
      readonly flow: 'plan' | 'architecture';
      readonly overallStatus: 'NOT_DECLARED' | 'AWAITING_EVIDENCE';
      readonly claimCount: number;
      readonly criticalCount: number;
      readonly falsificationReadyCount?: number;
      readonly missingFalsificationCount?: number;
      readonly approval: ProofApprovalPresentation;
    }
  | {
      readonly kind: 'evaluation';
      readonly overallStatus: 'NOT_DECLARED';
      readonly claimCount: 0;
      readonly criticalCount: 0;
      readonly criticalProvenCount: 0;
      readonly provenCount: 0;
      readonly contradictedCount: 0;
      readonly blockedCount: 0;
      readonly staleCount: 0;
      readonly unprovenCount: 0;
      readonly notVerifiedCount: 0;
      readonly coverage: 'NOT_DECLARED';
      readonly unmetCriticalClaims: readonly [];
      readonly otherHighlightedClaims: readonly [];
      readonly approval: ProofApprovalPresentation;
      readonly decisionContext: 'current_gate' | 'prospective_approval' | 'completion';
    }
  | {
      readonly kind: 'evaluation';
      readonly overallStatus: ClaimVerificationState;
      readonly claimCount: number;
      readonly criticalCount: number;
      readonly criticalProvenCount: number;
      readonly provenCount: number;
      readonly contradictedCount: number;
      readonly blockedCount: number;
      readonly staleCount: number;
      readonly unprovenCount: number;
      readonly notVerifiedCount: number;
      readonly coverage: 'NOT_DECLARED' | 'NOT_VERIFIED' | 'PROVEN';
      readonly headlineStatus: ClaimVerificationState;
      readonly primaryReason?: string;
      /** Every critical claim that is not proven; never capped. */
      readonly unmetCriticalClaims: readonly CompactProofClaim[];
      /** Non-critical findings for orientation; intentionally compact. */
      readonly otherHighlightedClaims: readonly CompactProofClaim[];
      readonly evidenceFreshness: 'CURRENT' | 'STALE' | 'NOT_VERIFIED';
      readonly revisionDigest?: string;
      readonly approval: ProofApprovalPresentation;
      readonly decisionContext: 'current_gate' | 'prospective_approval' | 'completion';
    };
