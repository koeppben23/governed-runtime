/**
 * @module integration/tools/implement-shared
 * @description Shared types and helpers for implement-record and implement-review.
 *
 * @version v1
 */

import type { ToolContext } from './helpers.js';
import {
  formatBlocked,
  writeStateWithArtifacts,
  writeStateWithArtifactsAndAuditOperationsAlreadyLocked,
} from './helpers.js';
import type { SessionState } from '../../state/schema.js';
import type { RailContext } from '../../rails/types.js';
import type { FlowGuardPolicy } from '../../config/policy.js';
import type {
  ReviewAttemptDiscoveryContext,
  ReviewFindings,
  ReviewObligation,
} from '../../state/evidence.js';
import type { resolveCeremonyProfile } from '../phase-tool-gate.js';
import {
  appendObligationWithAttempt,
  createReviewObligation,
  resolveFrozenReviewProfile,
  freezeReviewMaterial,
} from '../review/assurance.js';
import { classifyToolCallMode } from './review-validation-mode.js';
import { freezeCandidatePairAuthority } from '../../rails/repository-authority.js';
import { buildFrozenReviewMaterialContent } from '../review/reviewer-context.js';
import { resolveAttemptDiscoveryOrBlock } from '../review/discovery-attempt-context.js';
import { hasFrozenRepositoryAuthority } from '../../state/evidence-review.js';
import { materializeApprovedPlanContractResult } from '../proofgraph/materialize-contract.js';
import { latestUnknownOutcomeResolvedAt } from '../../state/evidence-mutation-episode.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Shared Types / Helpers
// ═══════════════════════════════════════════════════════════════════════════════

export function nextImplementationReviewIteration(state: SessionState): number {
  let latest = state.implReview?.iteration ?? 0;
  for (const findings of state.implReviewFindings ?? []) {
    latest = Math.max(latest, findings.iteration);
  }
  return latest + 1;
}

/**
 * Create the implementation-review obligation only after post-implementation
 * validation has reached IMPL_REVIEW. Both /implement (vacuous checks) and
 * /check (executed checks) use this boundary.
 *
 * Subject model (#815 parity): the implementation review subject is the
 * implementation itself, identified by its content-bound digest — the same
 * canonical identity used by subjectDigest, the frozen review material, and
 * the challenge evidence model (`ImplementationRef`). The subject scope is
 * therefore `implementation`-scoped and independent of repository evidence
 * authority: changedFiles are classification/context data (obligation.changedFiles),
 * and the frozen candidate pair is repository EVIDENCE authority only.
 */
export type ImplementationReviewActivationResult = {
  state: SessionState;
  obligation: ReviewObligation | null;
  attemptId: string | null;
  blocked?: { readonly code: string; readonly reason: string };
};

/**
 * Resolve the attempt-bound Discovery context a repository-governed mint must
 * carry, or fail closed with `REVIEWER_CONTEXT_UNAVAILABLE` (zero mutation).
 */
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
    obligationId: obligation.obligationId,
  });
  if (discovery.kind === 'blocked') {
    return { kind: 'blocked', reason: discovery.reason };
  }
  return { kind: 'ok', context: discovery.context };
}

/**
 * Build the implementation-review obligation candidate. The frozen repository
 * authority is the pre-mutation base (frozen at IMPLEMENTATION entry) plus the
 * content-addressed worktree candidate head (isolated index).
 */
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
    planVersion: input.planVersion,
    now: input.now,
    subjectDigest: digest,
    reviewMaterial: freezeReviewMaterial(
      buildFrozenReviewMaterialContent({
        obligationType: 'implement',
        state,
        artifact: JSON.stringify(state.implementation),
      }),
      digest,
    ),
    reviewProfile: resolveFrozenReviewProfile(state.policySnapshot),
    profileSource: 'policy_default',
    policySnapshot: state.policySnapshot,
    changedFiles,
    claimedTaskClass: state.claimedTaskClass,
    // Exact subject identity: the scope digest MUST equal the subject digest
    // (same variable by construction). No paths, revisions, or file lists —
    // repository locations are evidence, never subject authority.
    reviewSubjectScope: { kind: 'implementation', implementationDigest: digest },
    repositoryAuthority,
  });
}

export async function activateImplementationReviewObligation(
  state: SessionState,
  input: {
    subagentEnabled: boolean;
    iteration: number;
    planVersion: number;
    now: string;
    worktree: string;
  },
): Promise<ImplementationReviewActivationResult> {
  if (state.phase !== 'IMPL_REVIEW' || state.reducedCeremony !== null || !input.subagentEnabled) {
    return { state, obligation: null, attemptId: null };
  }

  // Frozen repository authority: pre-mutation base (frozen at IMPLEMENTATION
  // entry) + content-addressed worktree candidate head (isolated index). No
  // mutable HEAD snapshot — absence of authority makes repository evidence
  // unavailable, never approximated.
  const repositoryAuthority = await freezeCandidatePairAuthority(state, input.worktree);
  const changedFiles = state.implementation?.changedFiles ?? [];
  const obligation = buildImplementationReviewObligation(
    state,
    input,
    changedFiles,
    repositoryAuthority,
  );

  // Attempt-bound Discovery coherence: a repository-governed obligation must
  // be minted WITH its host-owned repository Discovery snapshot (schema
  // invariant). A structural resolution failure blocks the mint with zero
  // state mutation.
  const discovery = await resolveActivationDiscovery(state, obligation, input);
  if (discovery.kind === 'blocked') {
    return {
      state,
      obligation: null,
      attemptId: null,
      blocked: { code: 'REVIEWER_CONTEXT_UNAVAILABLE', reason: discovery.reason },
    };
  }

  const withAttempt = appendObligationWithAttempt(
    state.reviewAssurance,
    obligation,
    input.now,
    discovery.context,
  );
  return {
    state: {
      ...state,
      reviewAssurance: withAttempt.assurance,
    },
    obligation,
    attemptId: withAttempt.attemptId,
  };
}

/**
 * Materialize the approved-plan claim contract for a state that has just
 * advanced into IMPL_REVIEW, shared by /check and /implement. No-op for every
 * other phase.
 */
export async function materializeImplReviewContract(
  state: SessionState,
  worktree: string,
): Promise<SessionState> {
  if (state.phase !== 'IMPL_REVIEW') return state;
  const materialized = await materializeApprovedPlanContractResult(state, worktree);
  return materialized
    ? {
        ...state,
        proofContract: materialized.contract,
        proofContractCoverage: [...materialized.coverage],
      }
    : state;
}

/**
 * Single integration point for activating the implementation-review
 * obligation at IMPL_REVIEW entry, shared by /check (run-check tool) and
 * /implement (implement-record). On a mint-gate block the recorded evidence
 * is persisted WITHOUT the IMPL_REVIEW advance (an IMPL_REVIEW state without
 * a review obligation is an illegal persisted state) and the caller receives
 * the blocked response directly.
 */
export async function activateReviewObligationAndPersist(input: {
  state: SessionState;
  preAdvanceState: SessionState;
  subagentEnabled: boolean;
  iteration: number;
  planVersion: number;
  now: string;
  worktree: string;
  sessDir: string;
  locked?: boolean;
  persistPreAdvance?: boolean;
}): Promise<{ activated: ImplementationReviewActivationResult } | { response: string }> {
  const activated = await activateImplementationReviewObligation(input.state, {
    subagentEnabled: input.subagentEnabled,
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

export type ImplementArgs = {
  reviewVerdict?: 'accept' | 'changes_requested';
  reviewFindings?: ReviewFindings;
  reviewerUnavailable?: boolean;
};

export type ImplementRuntime = {
  args: ImplementArgs;
  context: ToolContext;
  worktree: string;
  sessDir: string;
  state: SessionState;
  policy: FlowGuardPolicy;
  ctx: RailContext;
  maxImplReviewIterations: number;
  subagentEnabled: boolean;
  fallbackToSelf: boolean;
  strictEnforcement: boolean;
};

export type ImplementationCeremony = ReturnType<typeof resolveCeremonyProfile>;

export function buildImplementRuntime(input: {
  args: ImplementArgs;
  context: ToolContext;
  worktree: string;
  sessDir: string;
  state: SessionState;
  policy: FlowGuardPolicy;
  ctx: RailContext;
}): ImplementRuntime {
  return {
    ...input,
    maxImplReviewIterations: input.policy.maxImplReviewIterations,
    subagentEnabled: input.policy.selfReview?.subagentEnabled ?? false,
    fallbackToSelf: input.policy.selfReview?.fallbackToSelf ?? false,
    strictEnforcement: input.policy.selfReview?.strictEnforcement ?? false,
  };
}

export function validateImplementSequence(args: ImplementArgs, state: SessionState): string | null {
  // 1. Canonical argument-shape validation.
  const mode = classifyToolCallMode('implement', {
    reviewVerdict: args.reviewVerdict,
    reviewFindings: args.reviewFindings,
    reviewerUnavailable: args.reviewerUnavailable,
  });
  if (mode.kind === 'invalid') return formatBlocked(mode.code, mode.params);

  // 2. State-dependent sequencing (requires SessionState; not pure shape).
  const receivedVerdict = args.reviewVerdict;
  const hasVerdict = typeof receivedVerdict === 'string' && receivedVerdict.length > 0;
  const verdictParams = receivedVerdict ? { receivedVerdict } : undefined;
  if (hasVerdict && !state.implementation) {
    return formatBlocked('IMPLEMENTATION_EVIDENCE_REQUIRED', verdictParams);
  }
  if (hasVerdict && state.phase !== 'IMPL_REVIEW') {
    return formatBlocked('IMPLEMENT_REVIEW_LOOP_REQUIRED', { phase: state.phase });
  }
  if (mode.kind === 'transport_failure_retry') {
    if (!state.implementation) return formatBlocked('IMPLEMENTATION_EVIDENCE_REQUIRED');
    if (state.phase !== 'IMPL_REVIEW') {
      return formatBlocked('IMPLEMENT_REVIEW_LOOP_REQUIRED', { phase: state.phase });
    }
  }
  return null;
}

// ─── Host Identity Normalization ──────────────────────────────────────────────

/**
 * Normalize reviewer-supplied findings into host-authoritative identity.
 *
 * Reviewer-supplied `findingId` values are not trusted — the host mints
 * fresh UUIDs for every finding. Legacy findings without an ID remain
 * readable without one. Never trusts, preserves, or forwards a reviewer-
 * supplied UUID as finding identity.
 */
export function normalizeHostFindings(findings: ReviewFindings): ReviewFindings {
  return {
    ...findings,
    blockingIssues: findings.blockingIssues.map((f) => ({
      ...f,
      findingId: crypto.randomUUID(),
    })),
    majorRisks: findings.majorRisks.map((f) => ({
      ...f,
      findingId: crypto.randomUUID(),
    })),
  };
}

/**
 * After an unknown-outcome resolution, every piece of pre-resolution
 * implementation evidence is unreliable. The review verdict must be bound to
 * a fresh worktree recapture: evidence recorded before the latest resolution
 * blocks the review loop until a new /implement records new evidence.
 */
export function unknownOutcomeRevalidationBlock(
  state: SessionState,
  implementationExecutedAt: string,
): string | null {
  const latestResolution = latestUnknownOutcomeResolvedAt(state.mutationEpisodeResolutions);
  if (latestResolution === null) return null;
  if (implementationExecutedAt <= latestResolution) {
    return formatBlocked('MUTATION_OUTCOME_UNKNOWN_REVALIDATION_REQUIRED', {
      resolvedAt: latestResolution,
    });
  }
  return null;
}
