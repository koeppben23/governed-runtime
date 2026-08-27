/**
 * @module evidence-mutation-episode
 * @description Canonical lifecycle records for host mutation dispatches,
 *              including the append-only unknown-outcome resolution authority.
 */

import { z } from 'zod';

export const MutationEpisode = z
  .object({
    episodeId: z.string().uuid(),
    hostCallId: z.string().min(1),
    toolName: z.string().min(1),
    /** Runtime instance that authorized the dispatch (per-process boot identity). */
    runtimeInstanceId: z.string().uuid(),
    /**
     * Fencing generation of the runtime lease that authorized the dispatch.
     * An unknown-outcome resolution requires a LATER generation — the
     * authorizing epoch must be provably over.
     */
    leaseGeneration: z.number().int().positive(),
    authorizedAt: z.string().datetime(),
    status: z.enum(['dispatch_authorized', 'completed']),
    completedAt: z.string().datetime().nullable(),
    outcome: z.enum(['success', 'failure', 'unknown']).nullable(),
    implementationDigest: z.string().min(1).nullable(),
    evidenceStatus: z.enum(['ineligible', 'eligible', 'stale']),
  })
  .strict()
  .superRefine((episode, context) => {
    if (episode.status === 'dispatch_authorized') {
      if (
        episode.completedAt !== null ||
        episode.outcome !== null ||
        episode.implementationDigest !== null ||
        episode.evidenceStatus !== 'ineligible'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'dispatch_authorized mutation episodes cannot carry completed evidence',
        });
      }
      return;
    }
    if (episode.completedAt === null || episode.outcome === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completed mutation episodes require completion time and outcome',
      });
    }
    if (episode.implementationDigest === null && episode.evidenceStatus !== 'ineligible') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unbound completed mutation episodes are ineligible',
      });
    }
    if (episode.implementationDigest !== null && episode.evidenceStatus === 'ineligible') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bound completed mutation episodes must be eligible or stale',
      });
    }
  })
  .readonly();
export type MutationEpisode = z.infer<typeof MutationEpisode>;

/**
 * Append-only resolution authority for host mutation episodes whose outcome
 * can never be observed (e.g. the process died between the Before- and
 * After-hook). The episode itself remains `dispatch_authorized`; the
 * resolution is what makes it non-blocking for /implement — and forces a
 * fresh worktree recapture instead of trusting pre-crash evidence.
 */
export const MutationEpisodeResolution = z
  .object({
    resolutionId: z.string().uuid(),
    hostCallId: z.string().min(1),
    status: z.literal('reconciled_after_unknown_outcome'),
    basis: z.literal('worktree_recapture'),
    resolvedAt: z.string().datetime(),
  })
  .strict()
  .readonly();
export type MutationEpisodeResolution = z.infer<typeof MutationEpisodeResolution>;

export type AuthorizeMutationEpisodeResult =
  | { readonly kind: 'authorized'; readonly episodes: MutationEpisode[] }
  | { readonly kind: 'replay_blocked'; readonly existing: MutationEpisode };

/**
 * Authorize exactly one host mutation dispatch per hostCallId.
 *
 * A second Before with an already-seen hostCallId is a replay of an existing
 * dispatch identity. Without a stable replay contract (dispatch generation,
 * request digest) it must never be treated as idempotent success — the host
 * call is blocked instead.
 */
export function authorizeMutationEpisode(
  episodes: readonly MutationEpisode[],
  input: {
    episodeId: string;
    hostCallId: string;
    toolName: string;
    runtimeInstanceId: string;
    leaseGeneration: number;
    authorizedAt: string;
  },
): AuthorizeMutationEpisodeResult {
  const existing = episodes.find((episode) => episode.hostCallId === input.hostCallId);
  if (existing) return { kind: 'replay_blocked', existing };
  return {
    kind: 'authorized',
    episodes: [
      ...episodes,
      {
        ...input,
        status: 'dispatch_authorized',
        completedAt: null,
        outcome: null,
        implementationDigest: null,
        evidenceStatus: 'ineligible',
      },
    ],
  };
}

export function completeMutationEpisode(
  episodes: readonly MutationEpisode[],
  hostCallId: string,
  completedAt: string,
  outcome: 'success' | 'failure' | 'unknown',
): MutationEpisode[] {
  return episodes.map((episode) =>
    episode.hostCallId === hostCallId && episode.status === 'dispatch_authorized'
      ? {
          ...episode,
          status: 'completed' as const,
          completedAt,
          outcome,
        }
      : episode,
  );
}

/**
 * Append an unknown-outcome resolution. Append-only: a hostCallId can never
 * be resolved twice, and resolutions are never removed or rewritten.
 */
export function resolveUnknownMutationOutcome(
  resolutions: readonly MutationEpisodeResolution[],
  input: { resolutionId: string; hostCallId: string; resolvedAt: string },
): MutationEpisodeResolution[] {
  if (resolutions.some((resolution) => resolution.hostCallId === input.hostCallId)) {
    return [...resolutions];
  }
  return [
    ...resolutions,
    {
      ...input,
      status: 'reconciled_after_unknown_outcome',
      basis: 'worktree_recapture',
    },
  ];
}

/**
 * Bind every completed unbound outcome and retain prior implementation
 * evidence as stale. Episodes resolved as `reconciled_after_unknown_outcome`
 * can never become eligible — their pre-crash outcome is unobservable and
 * their evidence must be superseded by a fresh worktree recapture.
 */
export function reconcileMutationEpisodes(
  episodes: readonly MutationEpisode[],
  resolutions: readonly MutationEpisodeResolution[],
  implementationDigest: string,
): MutationEpisode[] {
  const resolvedCallIds = new Set(resolutions.map((resolution) => resolution.hostCallId));
  return episodes.map((episode) => {
    if (episode.status !== 'completed') return episode;
    if (resolvedCallIds.has(episode.hostCallId)) {
      if (
        episode.implementationDigest !== null &&
        episode.implementationDigest !== implementationDigest
      ) {
        return { ...episode, evidenceStatus: 'stale' as const };
      }
      return episode;
    }
    if (episode.implementationDigest === null) {
      return { ...episode, implementationDigest, evidenceStatus: 'eligible' as const };
    }
    if (
      episode.implementationDigest !== implementationDigest &&
      episode.evidenceStatus === 'eligible'
    ) {
      return { ...episode, evidenceStatus: 'stale' as const };
    }
    return episode;
  });
}

export function hasUnresolvedMutationEpisodes(
  episodes: readonly MutationEpisode[],
  resolutions: readonly MutationEpisodeResolution[] = [],
): boolean {
  const resolvedCallIds = new Set(resolutions.map((resolution) => resolution.hostCallId));
  return episodes.some(
    (episode) =>
      episode.status === 'dispatch_authorized' && !resolvedCallIds.has(episode.hostCallId),
  );
}

/** Latest resolution time, or null when no unknown-outcome resolution exists. */
export function latestUnknownOutcomeResolvedAt(
  resolutions: readonly MutationEpisodeResolution[],
): string | null {
  let latest: string | null = null;
  for (const resolution of resolutions) {
    if (latest === null || resolution.resolvedAt > latest) latest = resolution.resolvedAt;
  }
  return latest;
}

export type ResolveMutationEpisodeDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'blocked'; readonly code: 'MUTATION_EPISODE_RUNTIME_EPOCH_ACTIVE' };

/**
 * Recovery Authority boundary: "outcome unknown" is an authority statement.
 * A resolution is only admissible when the resolving instance holds a lease
 * with a LATER generation than the episode's bound generation — generation
 * inequality is a fencing token: the superseding lease acquisition proves
 * the authorizing epoch ended (dead or stale holder), never mere process
 * identity difference.
 */
export function canResolveMutationEpisode(
  episode: MutationEpisode,
  currentLease: { readonly holderRuntimeInstanceId: string; readonly generation: number },
): ResolveMutationEpisodeDecision {
  if (currentLease.generation <= episode.leaseGeneration) {
    return { kind: 'blocked', code: 'MUTATION_EPISODE_RUNTIME_EPOCH_ACTIVE' };
  }
  return { kind: 'allow' };
}
