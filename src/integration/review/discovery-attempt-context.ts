/**
 * @module integration/review/discovery-attempt-context
 * @description Attempt-bound repository Discovery context resolution.
 *
 * Resolves the host-owned Discovery snapshot that a repository review attempt
 * is minted WITH. The resolution happens BEFORE any attempt is created; the
 * snapshot is advisory investigation context and is deliberately not part of
 * the frozen review subject or material identity.
 *
 * The underlying loader (`buildReviewDiscoveryContext`) is total and never
 * throws. Drift uncertainty degrades into an advisory `not_assessed` snapshot;
 * a missing/corrupt persisted Discovery basis, an unresolvable workspace
 * fingerprint, or an unprojectable snapshot is a STRUCTURAL failure that
 * blocks the attempt mint with `REVIEWER_CONTEXT_UNAVAILABLE`.
 *
 * @version v1
 */

import { computeFingerprint } from '../../adapters/workspace/index.js';
import type { SessionState } from '../../state/schema.js';
import type {
  RepositoryDiscoverySnapshot,
  ReviewAttemptDiscoveryContext,
} from '../../state/evidence.js';
import { buildReviewDiscoveryContext } from './discovery-context-loader.js';
import type { DiscoveryReviewContext } from './discovery-context-prompt.js';
import type { DiscoveryHealthProjection } from '../../discovery/discovery-health.js';
import type { DiscoveryDriftStatusProjection } from '../discovery-drift-status.js';

export type ReviewerDiscoveryResolution =
  | { readonly kind: 'repository'; readonly context: ReviewAttemptDiscoveryContext }
  | { readonly kind: 'not_applicable'; readonly context: ReviewAttemptDiscoveryContext }
  | { readonly kind: 'blocked'; readonly reason: string };

function projectHealth(
  health: DiscoveryHealthProjection | null | undefined,
): RepositoryDiscoverySnapshot['health'] {
  if (!health || health.status === 'unavailable') {
    return {
      status: 'unavailable',
      healthy: false,
      failedCollectorNames: [],
      hasBudgetExhaustion: false,
      ageWarning: null,
      notVerified: health ? [...health.notVerified] : [],
    };
  }
  return {
    status: health.healthy ? 'available' : 'degraded',
    healthy: health.healthy,
    failedCollectorNames: [...health.failedCollectorNames],
    hasBudgetExhaustion: health.hasBudgetExhaustion,
    ageWarning: health.ageWarning,
    notVerified: [],
  };
}

function projectDrift(
  drift: DiscoveryDriftStatusProjection | null | undefined,
): RepositoryDiscoverySnapshot['drift'] {
  const status =
    drift?.status === 'clean' || drift?.status === 'drifted'
      ? drift.status
      : drift?.status === 'unavailable'
        ? ('unavailable' as const)
        : ('not_assessed' as const);
  return {
    status,
    drifted: drift?.drifted ?? false,
    changedContributorNames: drift ? [...drift.changedContributorNames] : [],
    notVerified: drift ? [...drift.notVerified] : [],
  };
}

function projectCandidates(
  context: DiscoveryReviewContext,
): RepositoryDiscoverySnapshot['verificationCandidates'] {
  return (context.verificationCandidates ?? []).map((candidate) => ({
    ...(candidate.candidateId ? { candidateId: candidate.candidateId } : {}),
    kind: candidate.kind,
    command: candidate.command,
    source: candidate.source,
    confidence: candidate.confidence,
  }));
}

function projectSnapshot(
  context: DiscoveryReviewContext,
  observedAt: string,
  discoveryDigest: string | null,
  workspaceFingerprint: string | null,
): RepositoryDiscoverySnapshot {
  return {
    observedAt,
    discoveryDigest,
    workspaceFingerprint,
    health: projectHealth(context.health),
    drift: projectDrift(context.drift),
    detectedStack: context.detectedStack ?? null,
    verificationCandidates: projectCandidates(context),
    riskSurfaces: [
      ...(context.implementationGuidance?.surfaces ?? []).map((surface) => surface.label),
    ],
    warnings: [...(context.implementationGuidance?.warnings ?? [])],
    notVerified: [...(context.notVerified ?? [])],
  };
}

/**
 * Resolve the attempt-bound Discovery context for a repository review attempt.
 *
 * `repositoryGoverned` selects the semantics: `true` requires a host-owned
 * snapshot resolved right now; anything else is structurally
 * `not_applicable`. The flag is derived from the obligation's frozen
 * repository authority (`hasFrozenRepositoryAuthority`) — never from a bare
 * scope or subject-shape heuristic.
 *
 * Failure classification per the frozen contract:
 * - drift unavailable/not_assessed → ADVISORY: the snapshot is still minted
 *   and the reviewer marks drift-dependent claims NOT_VERIFIED.
 * - missing/corrupt persisted Discovery basis, unresolvable workspace
 *   fingerprint, or an unprojectable snapshot → STRUCTURAL: the attempt must
 *   not be minted (`REVIEWER_CONTEXT_UNAVAILABLE`).
 */
export async function resolveReviewAttemptDiscoveryContext(input: {
  readonly state: SessionState;
  readonly worktree: string;
  readonly repositoryGoverned: boolean;
  readonly now: string;
  readonly fingerprint?: string | null;
}): Promise<ReviewerDiscoveryResolution> {
  if (!input.repositoryGoverned) {
    return { kind: 'not_applicable', context: { kind: 'not_applicable' } };
  }
  let fingerprint = input.fingerprint ?? null;
  if (!fingerprint && input.worktree) {
    try {
      fingerprint = (await computeFingerprint(input.worktree)).fingerprint;
    } catch {
      fingerprint = null;
    }
  }
  if (!fingerprint) {
    return {
      kind: 'blocked',
      reason: 'workspace fingerprint could not be resolved for the repository Discovery basis',
    };
  }
  const context = await buildReviewDiscoveryContext({
    sessionState: input.state,
    fingerprint,
    worktree: input.worktree,
    includeDriftCheck: true,
  });
  // Structural boundary: an unavailable health projection means the persisted
  // Discovery basis itself is missing/corrupt/unreadable — the host cannot
  // supply the reviewer contract's host-owned evidence. Degraded-but-available
  // health stays advisory and mints with NOT_VERIFIED markers.
  if (!context.health || context.health.status === 'unavailable') {
    return {
      kind: 'blocked',
      reason: 'persisted Discovery basis is unavailable for this repository review',
    };
  }
  try {
    const snapshot = projectSnapshot(
      context,
      input.now,
      input.state.discoveryDigest ?? null,
      fingerprint,
    );
    return { kind: 'repository', context: { kind: 'repository', snapshot } };
  } catch (error) {
    return {
      kind: 'blocked',
      reason: `reviewer Discovery context could not be materialized: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Resolve the attempt-bound Discovery context for a repository-governed mint
 * or fail with a typed, formattable block. Single shared shape for every
 * artifact-flow call site (plan, architecture submit/review/restart), so the
 * coherence contract — repository-governed attempts are born with their
 * host-owned snapshot — has one implementation.
 */
export async function resolveAttemptDiscoveryOrBlock(input: {
  readonly state: SessionState;
  readonly worktree: string;
  readonly repositoryGoverned: boolean;
  readonly now: string;
  readonly obligationId?: string;
}): Promise<
  | { readonly kind: 'ok'; readonly context: ReviewAttemptDiscoveryContext }
  | { readonly kind: 'blocked'; readonly reason: string; readonly obligationId?: string }
> {
  const resolved = await resolveReviewAttemptDiscoveryContext(input);
  if (resolved.kind === 'blocked') {
    return { kind: 'blocked', reason: resolved.reason, obligationId: input.obligationId };
  }
  return { kind: 'ok', context: resolved.context };
}
