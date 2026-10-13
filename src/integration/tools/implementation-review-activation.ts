/**
 * @module integration/tools/implementation-review-activation
 * @description Cross-command activation authority for implementation review.
 */

import { declaredTaskClassFor } from '../phase-tool-gate.js';
import { REVIEW_DISCOVERY_PROVIDER } from '../discovery/review-discovery-provider.js';
import { formatBlocked } from '../blocked-result.js';
import {
  writeStateWithArtifacts,
  writeStateWithArtifactsAndAuditOperationsAlreadyLocked,
} from './helpers.js';
import type { SessionState } from '../../state/schema.js';
import type {
  ReviewAttempt,
  ReviewAttemptDiscoveryContext,
  ReviewObligation,
} from '../../state/evidence.js';
import {
  appendObligationWithAttempt,
  createReviewObligation,
  freezeReviewMaterial,
} from '../review/obligations/assurance.js';
import { findBindableAttempt } from '../../state/review-continuation.js';
import type { ReviewDispatchAuthority } from '../review/dispatch/dispatch-authority.js';
import { buildChildSessionReviewInstruction } from '../review/dispatch/child-session-instruction.js';
import {
  resolveReviewOrchestrationMode,
  resolveRuntimeReviewPlatform,
} from '../review/dispatch/orchestration-mode.js';
import { freezeCandidatePairAuthority } from '../../rails/repository-authority.js';
import { buildFrozenReviewMaterialContent } from '../review/context/reviewer-context.js';
import { resolveAttemptDiscoveryOrBlock } from '../review/context/discovery-attempt-context.js';
import { renderPlanClaimDeclarations } from '../../presentation/index.js';
import { hasFrozenRepositoryAuthority } from '../../state/evidence-review-authority.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { reducedCeremonyReady } from '../../machine/guards.js';
import { materializeApprovedPlanContractResult } from '../proofgraph/materialize-contract.js';

export type ImplementationReviewActivationResult = {
  state: SessionState;
  obligation: ReviewObligation | null;
  attempt: ReviewAttempt | null;
  blocked?: { readonly code: string; readonly reason: string };
};

export function nextImplementationReviewIteration(state: SessionState): number {
  let latest = state.implReview?.iteration ?? 0;
  for (const findings of state.implReviewFindings) {
    latest = Math.max(latest, findings.iteration);
  }
  return latest + 1;
}

/** Build the native implementation-review dispatch instruction for an exact authority. */
export function buildImplementationReviewInstruction(authority: ReviewDispatchAuthority) {
  const platform = resolveRuntimeReviewPlatform();
  const mode = resolveReviewOrchestrationMode({
    platform,
    nativeReviewerAvailable: platform !== 'unknown',
  });
  return buildChildSessionReviewInstruction({
    mode,
    platform,
    authority,
    iteration: authority.obligation.iteration,
    planVersion: authority.obligation.planVersion,
    ...(authority.attempt.observationCapability !== undefined
      ? { observationCapability: authority.attempt.observationCapability }
      : {}),
  });
}

async function resolveActivationDiscovery(
  state: SessionState,
  obligation: ReviewObligation,
  input: { readonly now: string; readonly worktree: string },
): Promise<
  | { readonly kind: 'ok'; readonly context: ReviewAttemptDiscoveryContext }
  | { readonly kind: 'blocked'; readonly reason: string }
> {
  const discovery = await resolveAttemptDiscoveryOrBlock({
    state,
    worktree: input.worktree,
    repositoryGoverned: hasFrozenRepositoryAuthority(obligation),
    now: input.now,
    discoveryProvider: REVIEW_DISCOVERY_PROVIDER,
    obligationId: obligation.obligationId,
  });
  if (discovery.kind === 'blocked') return { kind: 'blocked', reason: discovery.reason };
  return { kind: 'ok', context: discovery.context };
}

function buildImplementationReviewObligation(
  state: SessionState,
  input: { readonly iteration: number; readonly planVersion: number; readonly now: string },
  changedFiles: readonly string[],
  repositoryAuthority: Awaited<ReturnType<typeof freezeCandidatePairAuthority>>,
): ReviewObligation {
  const digest = state.implementation?.digest ?? `impl-${input.now}`;
  return createReviewObligation({
    obligationType: 'implement',
    iteration: input.iteration,
    reviewCycle: state.reviewCycles.implementation,
    planVersion: input.planVersion,
    now: input.now,
    subjectDigest: digest,
    reviewMaterial: freezeReviewMaterial(
      buildFrozenReviewMaterialContent({
        obligationType: 'implement',
        state,
        artifact: JSON.stringify(state.implementation),
        renderPlanClaimDeclarations,
      }),
      digest,
    ),
    policySnapshot: state.policySnapshot,
    changedFiles,
    declaredTaskClass: declaredTaskClassFor(state),
    escalatedTaskClass: state.claimedTaskClass,
    reviewSubjectScope: { kind: 'implementation', implementationDigest: digest },
    repositoryAuthority,
  });
}

/**
 * Create the implementation-review obligation only after post-implementation
 * validation reaches IMPL_REVIEW. Both /implement and /check use this authority.
 */
export async function activateImplementationReviewObligation(
  state: SessionState,
  input: {
    iteration: number;
    planVersion: number;
    now: string;
    worktree: string;
  },
): Promise<ImplementationReviewActivationResult> {
  if (state.phase !== 'IMPL_REVIEW' || state.reducedCeremony !== null) {
    return { state, obligation: null, attempt: null };
  }

  const repositoryAuthority = await freezeCandidatePairAuthority(state, input.worktree);
  const obligation = buildImplementationReviewObligation(
    state,
    input,
    state.implementation?.changedFiles ?? [],
    repositoryAuthority,
  );
  const discovery = await resolveActivationDiscovery(state, obligation, input);
  if (discovery.kind === 'blocked') {
    return {
      state,
      obligation: null,
      attempt: null,
      blocked: { code: 'REVIEWER_CONTEXT_UNAVAILABLE', reason: discovery.reason },
    };
  }

  const withAttempt = appendObligationWithAttempt(
    state.reviewAssurance,
    obligation,
    input.now,
    discovery.context,
  );
  const attempt = findBindableAttempt(withAttempt.assurance, obligation.obligationId);
  if (!attempt) {
    return {
      state,
      obligation: null,
      attempt: null,
      blocked: {
        code: 'REVIEW_ATTEMPT_UNAVAILABLE',
        reason: 'the implementation review obligation was minted without a bindable attempt',
      },
    };
  }
  return {
    state: { ...state, reviewAssurance: withAttempt.assurance },
    obligation,
    attempt,
  };
}

/**
 * Materialize the approved-plan claim contract at the post-validation review
 * entry. Two entries carry a plan whose implementation must be evaluated:
 *
 * - `IMPL_REVIEW` (full ceremony), and
 * - `EVIDENCE_REVIEW` reached through the reduced-ceremony shortcut, which is
 *   legal only while the persisted reduced decision still satisfies the
 *   canonical machine authority `reducedCeremonyReady`.
 *
 * Reconciliation: certificate-bound claims from a superseded plan are replaced
 * by the current materialization, while advisory claims that never carried a
 * certificate approval (manual `/declare-contract` declarations) are
 * preserved. A stale manual claim is NOT silently deleted — it stays in the
 * contract and the evaluator's freshness authority reports it STALE /
 * NOT_VERIFIED against the current implementation. Manual claims remain
 * advisory: they never gain approval authority and never become gate-eligible.
 *
 * Idempotency is bound to the CURRENT plan/implementation/evidence generation:
 * only a persisted contract that already equals this reconciliation is left
 * untouched. An invalid certificate over existing declarations materializes
 * the explicit coverage gap (never a silent claimless fallback); the evidence
 * gate keeps blocking that state through the certificate-invalid enforcement
 * path.
 */
export async function materializePostValidationContract(
  state: SessionState,
  worktree: string,
  /**
   * The review entry the caller's advance will take, when materialization must
   * happen BEFORE the advance (an approval's basis must already include the
   * contract and its admission). Omitted for callers that materialize on the
   * already-advanced state.
   */
  entryPhase?: 'IMPL_REVIEW' | 'EVIDENCE_REVIEW',
): Promise<SessionState> {
  const phase = entryPhase ?? state.phase;
  const entersFullReview = phase === 'IMPL_REVIEW';
  const entersReducedReview = phase === 'EVIDENCE_REVIEW' && reducedCeremonyReady(state);
  if (!entersFullReview && !entersReducedReview) return state;

  const materialized = await materializeApprovedPlanContractResult(state, worktree);
  const planClaimIds = new Set(materialized.contract.claims.map((claim) => claim.claimId));
  const preservedAdvisoryClaims = (state.proofContract?.claims ?? []).filter(
    (claim) => !hasCertificateApproval(claim) && !planClaimIds.has(claim.claimId),
  );
  const nextContract: NonNullable<SessionState['proofContract']> = {
    ...materialized.contract,
    claims: [...materialized.contract.claims, ...preservedAdvisoryClaims],
  };
  const nextCoverage = [...materialized.coverage];
  if (
    state.proofContract !== undefined &&
    canonicalJsonStringify(state.proofContract) === canonicalJsonStringify(nextContract) &&
    canonicalJsonStringify(state.proofContractCoverage ?? []) ===
      canonicalJsonStringify(nextCoverage)
  ) {
    return state;
  }
  return {
    ...state,
    proofContract: nextContract,
    proofContractCoverage: nextCoverage,
  };
}

function hasCertificateApproval(
  claim: NonNullable<SessionState['proofContract']>['claims'][number],
): boolean {
  return (
    claim.provenance !== null &&
    claim.provenance.kind === 'canonical_authority' &&
    claim.provenance.approval !== undefined
  );
}

/**
 * Activate the implementation-review obligation at IMPL_REVIEW entry. A mint
 * block persists the pre-advance state so an illegal unreviewable state is never stored.
 */
export async function activateReviewObligationAndPersist(input: {
  state: SessionState;
  preAdvanceState: SessionState;
  iteration: number;
  planVersion: number;
  now: string;
  worktree: string;
  sessDir: string;
  locked?: boolean;
  persistPreAdvance?: boolean;
}): Promise<{ activated: ImplementationReviewActivationResult } | { response: string }> {
  const activated = await activateImplementationReviewObligation(input.state, {
    iteration: input.iteration,
    planVersion: input.planVersion,
    now: input.now,
    worktree: input.worktree,
  });
  if (!activated.blocked) return { activated };
  if (input.persistPreAdvance) {
    if (input.locked) {
      await writeStateWithArtifactsAndAuditOperationsAlreadyLocked(
        input.sessDir,
        input.preAdvanceState,
      );
    } else {
      await writeStateWithArtifacts(input.sessDir, input.preAdvanceState);
    }
  }
  return { response: formatBlocked(activated.blocked.code, { reason: activated.blocked.reason }) };
}
