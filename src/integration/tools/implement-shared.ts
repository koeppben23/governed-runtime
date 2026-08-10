/**
 * @module integration/tools/implement-shared
 * @description Shared types and helpers for implement-record and implement-review.
 *
 * @version v1
 */

import type { ToolContext } from './helpers.js';
import { formatBlocked } from './helpers.js';
import type { SessionState } from '../../state/schema.js';
import type { RailContext } from '../../rails/types.js';
import type { FlowGuardPolicy } from '../../config/policy.js';
import type { ReviewFindings, ReviewObligation } from '../../state/evidence.js';
import type { resolveCeremonyProfile } from '../phase-tool-gate.js';
import {
  appendObligationWithAttempt,
  createReviewObligation,
  resolveFrozenReviewProfile,
} from '../review/assurance.js';
import { classifyToolCallMode } from './review-validation-mode.js';
import { headCommitFull } from '../../adapters/git.js';

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
 */
export async function activateImplementationReviewObligation(
  state: SessionState,
  input: {
    subagentEnabled: boolean;
    iteration: number;
    planVersion: number;
    now: string;
    worktree: string;
  },
): Promise<{ state: SessionState; obligation: ReviewObligation | null; attemptId: string | null }> {
  if (state.phase !== 'IMPL_REVIEW' || state.reducedCeremony !== null || !input.subagentEnabled) {
    return { state, obligation: null, attemptId: null };
  }

  const headSha = await headCommitFull(input.worktree);
  const obligation = createReviewObligation({
    obligationType: 'implement',
    iteration: input.iteration,
    planVersion: input.planVersion,
    now: input.now,
    subjectDigest: state.implementation?.candidate.candidateDigest ?? `impl-${input.now}`,
    reviewProfile: resolveFrozenReviewProfile(state.policySnapshot),
    profileSource: 'policy_default',
    policySnapshot: state.policySnapshot,
    changedFiles: state.implementation?.candidate.changedPaths ?? [],
    claimedTaskClass: state.claimedTaskClass,
    repositoryRevisionProvenance: headSha
      ? { kind: 'available', headSha }
      : { kind: 'unavailable', reason: 'head_revision_not_resolved' },
  });
  const withAttempt = appendObligationWithAttempt(state.reviewAssurance, obligation, input.now);
  return {
    state: {
      ...state,
      reviewAssurance: withAttempt.assurance,
    },
    obligation,
    attemptId: withAttempt.attemptId,
  };
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
