/**
 * @module integration/tools/plan/plan-claim-submission
 * @description /plan-specific partial-acceptance policy for ProofGraph claims.
 */

import { defaultReasonRegistry } from '../../../config/reasons.js';
import { canonicalJsonStringify } from '../../../shared/canonical-json.js';
import { IntegrationInvariantError } from '../../errors.js';
import type { SessionState } from '../../../state/schema.js';
import { normalizePlanClaims } from '../../../state/proofgraph-approval.js';
import {
  classifyProofClaimContract,
  formatClaimContractViolation,
} from '../../proofgraph/claim-contract.js';
import { MUTATION_PROFILE_IDS } from '../../proofgraph/mutation-provider.js';
import { STRUCTURAL_SURFACE_IDS } from '../../proofgraph/structural-provider.js';
import { formatBlocked } from '../../blocked-result.js';

import type { PlanArgs, PlanClaimSubmissionDiagnostics } from './plan-types.js';

export type PlanClaimSubmissionClassification =
  | {
      readonly kind: 'ok';
      readonly args: PlanArgs;
      readonly diagnostics?: PlanClaimSubmissionDiagnostics;
    }
  | { readonly kind: 'blocked'; readonly message: string };

/** Reject blocking declarations before review; only nonblocking rejections permit partial acceptance. */
export function classifyPlanClaimSubmission(
  args: PlanArgs,
  state: SessionState,
  digest: (value: string) => string,
): PlanClaimSubmissionClassification {
  if (args.claims === undefined) {
    const diagnostics = state.plan?.claimSubmissionDiagnostics;
    const blocked = blockRejectedDeclarations(diagnostics, 'historical');
    return blocked ?? { kind: 'ok', args };
  }
  if (args.claims.length === 0) return { kind: 'ok', args };
  const normalized = normalizePlanClaims(args.claims);
  if (normalized === undefined) {
    throw new IntegrationInvariantError(
      'PROOFGRAPH_CLAIM_NORMALIZATION_UNAVAILABLE',
      'normalizing submitted plan claims produced no canonical declarations',
    );
  }
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
      ...(claim.counterexampleRequirement !== undefined
        ? { counterexampleRequirement: claim.counterexampleRequirement }
        : {}),
      ...(claim.structuralSurface !== undefined
        ? { structuralSurface: claim.structuralSurface }
        : {}),
      ...(claim.mutationProfile !== undefined ? { mutationProfile: claim.mutationProfile } : {}),
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

  const diagnostics = buildPartialAcceptanceDiagnostics(normalized, batch, digest);
  const blocked = blockRejectedDeclarations(diagnostics, 'submitted');
  if (blocked) return blocked;

  const acceptedIndexes = new Set(batch.accepted.map((entry) => entry.index));
  const acceptedClaims = args.claims.filter((_, index) => acceptedIndexes.has(index));
  return {
    kind: 'ok',
    args: { ...args, claims: acceptedClaims },
    diagnostics,
  };
}

function blockRejectedDeclarations(
  diagnostics: PlanClaimSubmissionDiagnostics | undefined,
  origin: 'historical' | 'submitted',
): Extract<PlanClaimSubmissionClassification, { kind: 'blocked' }> | undefined {
  if (!diagnostics) return undefined;
  const first = diagnostics.rejectedClaims.find(
    (claim) => claim.disposition === 'rejected_blocking',
  );
  if (!first) return undefined;
  const canonicalResponse = formatBlocked(
    'PROOFGRAPH_CLAIM_NOT_DECLARED',
    {
      claimRef: first.claimRef,
      field: 'declaration admission',
      detail:
        'blocking declarations must be corrected or explicitly withdrawn before admitting this revision',
      consequence: 'No plan version or independent review was created by this rejected call.',
    },
    { claimSubmissionDiagnostics: diagnostics, claimSubmissionDiagnosticsOrigin: origin },
  );
  return {
    kind: 'blocked',
    message: appendClaimPresentation(canonicalResponse, diagnostics.rejectedClaims, origin),
  };
}

/** Append declaration details without replacing the canonical blocker or its recovery. */
function appendClaimPresentation(
  canonicalResponse: string,
  claims: PlanClaimSubmissionDiagnostics['rejectedClaims'],
  origin: 'historical' | 'submitted',
): string {
  const response = JSON.parse(canonicalResponse) as {
    presentation: { markdown: string };
    [key: string]: unknown;
  };
  const heading =
    origin === 'historical'
      ? 'Historical rejected declarations (carried over)'
      : 'Declarations rejected by this call';
  const declarations = claims
    .map(
      (claim) =>
        `### ${claim.statement}\n\n` +
        `- Claim: ${claim.claimRef}\n- Disposition: ${claim.disposition}\n\n` +
        `${claim.reason}\n\nRecovery:\n` +
        claim.recovery.map((step) => `- ${step}`).join('\n'),
    )
    .join('\n\n');
  return JSON.stringify({
    ...response,
    presentation: {
      ...response.presentation,
      markdown: `${response.presentation.markdown}\n\n## ${heading}\n\n${declarations}`,
    },
  });
}

function buildPartialAcceptanceDiagnostics(
  normalized: NonNullable<ReturnType<typeof normalizePlanClaims>>,
  batch: ReturnType<typeof classifyProofClaimContract>,
  digest: (value: string) => string,
): PlanClaimSubmissionDiagnostics {
  const acceptedIndexes = new Set(batch.accepted.map((entry) => entry.index));
  const rejected = [...batch.rejectedNonBlocking, ...batch.rejectedBlocking];
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
    submittedClaimDeclarationsDigest: digest(canonicalJsonStringify(submittedDeclarations)),
    acceptedClaimDeclarationsDigest: digest(canonicalJsonStringify(acceptedDeclarations)),
    rejectedClaims: rejected.map(({ claim, result, disposition }) => {
      const claimId = claim.claimId;
      if (claimId === undefined) {
        throw new IntegrationInvariantError(
          'PROOFGRAPH_CLAIM_ID_MISSING',
          'a rejected plan claim declaration is missing its canonical claim id',
        );
      }
      const code = 'PROOFGRAPH_CLAIM_NOT_DECLARED';
      const formatted = defaultReasonRegistry.format(code, {
        claimRef: claimId,
        field: result.field,
        detail: result.detail,
        // The same catalog code covers partial acceptance and the blocking
        // withdrawal case; the consequence sentence must follow the severity.
        consequence:
          disposition === 'rejected_blocking'
            ? 'Rejected blocking declarations prevent approval until admitted or explicitly withdrawn.'
            : 'The plan and its accepted claims remain valid.',
      });
      return {
        claimRef: claimId,
        statement: claim.statement,
        critical: claim.critical,
        disposition,
        code,
        reason: formatted.reason,
        recovery: [...formatted.recovery],
      };
    }),
  };
}
