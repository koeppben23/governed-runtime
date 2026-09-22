/**
 * @module integration/tools/implementation/implement-shared
 * @description Shared types and helpers for implement-record and implement-review.
 *
 * @version v1
 */

import type { ToolContext } from '../helpers.js';
import { formatBlocked } from '../../blocked-result.js';
import type { SessionState } from '../../../state/schema.js';
import type { RailContext } from '../../../rails/types.js';
import type { FlowGuardPolicy } from '../../../config/policy.js';
import type { LoopVerdict, ReviewFindings } from '../../../state/evidence.js';
import type { resolveCeremonyProfile } from '../../phase-tool-gate.js';
import { classifyToolCallMode } from '../review-validation-mode.js';
import { latestUnknownOutcomeResolvedAt } from '../../../state/evidence-mutation-episode.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Shared Types / Helpers
// ═══════════════════════════════════════════════════════════════════════════════

export type ImplementArgs = {
  reviewVerdict?: LoopVerdict;
  reviewerUnavailable?: boolean;
  /** Explicit transport-recovery intent: re-arm/re-emit the pending review dispatch. */
  reviewRecovery?: 'retry_transport';
};

export type ImplementRuntime = {
  args: ImplementArgs;
  context: ToolContext;
  worktree: string;
  sessDir: string;
  state: SessionState;
  policy: FlowGuardPolicy;
  ctx: RailContext;
  maxImplementationReviewIterations: number;
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
    maxImplementationReviewIterations: input.policy.reviewBudget.implementation,
  };
}

export function validateImplementSequence(args: ImplementArgs, state: SessionState): string | null {
  // 1. Canonical argument-shape validation.
  const mode = classifyToolCallMode('implement', {
    reviewVerdict: args.reviewVerdict,
    reviewerUnavailable: args.reviewerUnavailable,
    reviewRecovery: args.reviewRecovery,
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
  if (mode.kind === 'transport_failure_retry' || mode.kind === 'transport_recovery') {
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
