/**
 * @module integration/review/discovery-attempt-context
 * @description Attempt-bound repository Discovery context resolution.
 *
 * Resolves the host-owned Discovery snapshot that a repository review attempt
 * is minted WITH. The resolution happens BEFORE any attempt is created; the
 * snapshot is advisory investigation context and is deliberately not part of
 * the frozen review subject or material identity.
 *
 * The underlying loader (`buildReviewDiscoveryContext`) is total: it never
 * throws. A missing/corrupt Discovery basis degrades into an advisory
 * `unavailable`/`not_assessed` snapshot — never into a block.
 * `REVIEWER_CONTEXT_UNAVAILABLE` is reserved for the structural case where the
 * resolved context cannot be projected into the canonical snapshot schema.
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
    changedCollectorNames: drift ? [...drift.changedCollectorNames] : [],
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
): RepositoryDiscoverySnapshot {
  return {
    observedAt,
    discoveryDigest,
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
 * `reviewSubjectKind` selects the semantics: `repository_change` requires a
 * host-owned snapshot resolved right now (advisory, never a governance gate);
 * anything else is structurally `not_applicable`.
 */
export async function resolveReviewAttemptDiscoveryContext(input: {
  readonly state: SessionState;
  readonly worktree: string;
  readonly reviewSubjectKind: string | undefined;
  readonly now: string;
  readonly fingerprint?: string | null;
}): Promise<ReviewerDiscoveryResolution> {
  if (input.reviewSubjectKind !== 'repository_change') {
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
  const context = await buildReviewDiscoveryContext({
    sessionState: input.state,
    fingerprint,
    worktree: input.worktree,
    includeDriftCheck: true,
  });
  try {
    const snapshot = projectSnapshot(context, input.now, fingerprint);
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
