/**
 * @module integration/tools/plan-claim-submission
 * @description /plan-specific partial-acceptance policy for ProofGraph claims.
 */

import { defaultReasonRegistry } from '../../config/reasons.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import type { SessionState } from '../../state/schema.js';
import { normalizePlanClaims } from '../../state/proofgraph-approval.js';
import {
  classifyProofClaimContract,
  formatClaimContractViolation,
} from '../proofgraph/claim-contract.js';
import { MUTATION_PROFILE_IDS } from '../proofgraph/mutation-provider.js';
import { STRUCTURAL_SURFACE_IDS } from '../proofgraph/structural-provider.js';
import { formatBlocked } from './helpers.js';
import type { PlanArgs, PlanClaimSubmissionDiagnostics } from './plan-types.js';

export type PlanClaimSubmissionClassification =
  | {
      readonly kind: 'ok';
      readonly args: PlanArgs;
      readonly diagnostics?: PlanClaimSubmissionDiagnostics;
    }
  | { readonly kind: 'blocked'; readonly message: string };

/** Keep set-level failures fail-closed; persist rejected declarations for later admission. */
export function classifyPlanClaimSubmission(
  args: PlanArgs,
  state: SessionState,
  digest: (value: string) => string,
): PlanClaimSubmissionClassification {
  if (!args.claims || args.claims.length === 0) return { kind: 'ok', args };
  const normalized = normalizePlanClaims(args.claims)!;
  const batch = classifyProofClaimContract({
    source: 'plan',
    activeChecks: state.activeChecks,
    allowedSurfaces: STRUCTURAL_SURFACE_IDS,
    allowedMutationProfiles: MUTATION_PROFILE_IDS,
    verificationCandidates: state.verificationCandidates ?? [],
    claims: normalized.map((claim) => ({
      claimId: claim.claimId,
      statement: claim.statement,
      critical: claim.critical,
      claimScope: claim.claimScope,
      positiveCheckId: claim.expectedCheckId,
      counterexampleRequirement: claim.counterexampleRequirement,
      structuralSurface: claim.structuralSurface,
      mutationProfile: claim.mutationProfile,
      authoritySectionId: claim.authoritySectionId,
    })),
  });
  const blocking = batch.setViolations[0];
  if (blocking) {
    return {
      kind: 'blocked',
      message: formatClaimContractViolation(blocking, (code, params) =>
        formatBlocked(code, params, {
          recoveryAction: 'Run /plan after correcting the blocked claim declaration.',
        }),
      ),
    };
  }
  const rejected = [...batch.rejectedNonBlocking, ...batch.rejectedBlocking];
  if (rejected.length === 0) return { kind: 'ok', args };

  const acceptedIndexes = new Set(batch.accepted.map((entry) => entry.index));
  const acceptedClaims = args.claims.filter((_, index) => acceptedIndexes.has(index));
  const submittedDeclarations = {
    flow: 'plan' as const,
    version: 'v2' as const,
    claims: normalized,
  };
  const acceptedDeclarations = {
    flow: 'plan' as const,
    version: 'v2' as const,
    claims: normalized.filter((_, index) => acceptedIndexes.has(index)),
  };
  return {
    kind: 'ok',
    args: { ...args, claims: acceptedClaims },
    diagnostics: {
      submittedClaimDeclarationsDigest: digest(canonicalJsonStringify(submittedDeclarations)),
      acceptedClaimDeclarationsDigest: digest(canonicalJsonStringify(acceptedDeclarations)),
      rejectedClaims: rejected.map(({ claim, result }) => {
        const code = 'PROOFGRAPH_CLAIM_NOT_DECLARED';
        const formatted = defaultReasonRegistry.format(code, {
          claimRef: claim.claimId!,
          field: result.field,
          detail: result.detail,
        });
        return {
          claimRef: claim.claimId!,
          statement: claim.statement,
          critical: claim.critical,
          disposition: claim.critical
            ? ('rejected_blocking' as const)
            : ('rejected_non_blocking' as const),
          code,
          reason: formatted.reason,
          recovery: [...formatted.recovery],
        };
      }),
    },
  };
}
