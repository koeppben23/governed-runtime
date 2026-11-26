/**
 * @module integration/tools/plan/plan-preflight
 * @description Single structural preflight for plan submissions and revisions.
 *
 * Order is intentional: evidence design, claim lineage, then finding responses.
 * The preflight never judges semantic sufficiency and never consumes a review
 * obligation; callers run it before any plan version or review mutation.
 */

import type { VerificationCandidate } from '../../../state/discovery-schemas.js';
import type { PlanClaimDeclaration } from '../../../state/proofgraph-approval.js';
import type { ReviewFindings } from '../../../state/evidence.js';
import { validateEvidenceDesign, type PlanPreflightDiagnostic } from './plan-evidence-design.js';
import { validateClaimChanges, validateFindingResolutions } from './plan-closure-ledger.js';

export type PlanPreflightResult =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'blocked';
      readonly code:
        | 'PLAN_EVIDENCE_DESIGN_REQUIRED'
        | 'PLAN_EVIDENCE_DESIGN_INVALID'
        | 'PLAN_CLAIM_LINEAGE_REQUIRED'
        | 'PLAN_CLAIM_LINEAGE_INVALID'
        | 'PLAN_CRITICAL_CLAIM_DOWNGRADE_FORBIDDEN'
        | 'PLAN_FINDING_RESOLUTION_REQUIRED'
        | 'PLAN_FINDING_RESOLUTION_INVALID'
        | 'PLAN_REVIEW_FEEDBACK_UNAVAILABLE';
      readonly reason: string;
      readonly diagnostics: readonly PlanPreflightDiagnostic[];
    };

export function runPlanPreflight(input: {
  readonly planText: string;
  readonly currentClaims: readonly PlanClaimDeclaration[];
  readonly priorClaims: readonly PlanClaimDeclaration[];
  readonly verificationCandidates: readonly VerificationCandidate[];
  readonly priorBlockingFindings?: readonly ReviewFindings['blockingIssues'][number][];
  readonly reviewObligation?: {
    readonly obligationId: string;
    readonly iteration: number;
    readonly planVersion: number;
  };
}): PlanPreflightResult {
  const evidence = validateEvidenceDesign({
    planText: input.planText,
    claims: input.currentClaims,
    verificationCandidates: input.verificationCandidates,
  });
  if (evidence.kind === 'blocked') return evidence;

  const lineage = validateClaimChanges({
    planText: input.planText,
    priorClaims: input.priorClaims,
    currentClaims: input.currentClaims,
  });
  if (lineage.kind === 'blocked') return lineage;

  if (input.reviewObligation !== undefined) {
    const findings = validateFindingResolutions({
      planText: input.planText,
      findings: input.priorBlockingFindings ?? [],
      obligation: input.reviewObligation,
    });
    if (findings.kind === 'blocked') return findings;
  }
  return { kind: 'ok' };
}
