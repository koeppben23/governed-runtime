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
    // An unobservable outcome is not evidence. Binding it to an implementation
    // digest would launder a missing host signal into `eligible` evidence that
    // is indistinguishable from a confirmed success — the exact approximation
    // the `unknown` classification exists to prevent. The state is made
    // unrepresentable here so that EVERY write path fails closed, not just the
    // binding path known today. Recovery is the append-only unknown-outcome
    // resolution, which forces a fresh worktree recapture.
    if (
      episode.outcome === 'unknown' &&
      (episode.implementationDigest !== null || episode.evidenceStatus !== 'ineligible')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'a mutation episode with an unobservable outcome cannot carry bound or eligible ' +
          'evidence; it requires an unknown-outcome resolution and a fresh worktree recapture',
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
 *
 * The resolution DUARABLY binds the fencing authority that made it admissible:
 * `resolvingRuntimeInstanceId` and `resolvingLeaseGeneration` prove — from the
 * persisted state alone — that the resolving instance held a lease with a
 * LATER generation than the episode's authorizing generation.
 */
export const MutationEpisodeResolution = z
  .object({
    resolutionId: z.string().uuid(),
    hostCallId: z.string().min(1),
    status: z.literal('reconciled_after_unknown_outcome'),
    basis: z.literal('worktree_recapture'),
    resolvedAt: z.string().datetime(),
    /** Runtime instance that held the lease authorizing this resolution. */
    resolvingRuntimeInstanceId: z.string().uuid(),
    /**
     * Lease generation under which the resolution was granted. MUST be LATER
     * than the resolved episode's `leaseGeneration` (enforced by the state
     * invariant in schema.ts).
     */
    resolvingLeaseGeneration: z.number().int().positive(),
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
  toolName: string,
  completedAt: string,
  outcome: 'success' | 'failure' | 'unknown',
): MutationEpisode[] {
  return episodes.map((episode) =>
    episode.hostCallId === hostCallId &&
    episode.toolName === toolName &&
    episode.status === 'dispatch_authorized'
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
 * be resolved twice, and resolutions are never removed or rewritten. The
 * resolution durably binds the fencing authority under which it was granted.
 */
export function resolveUnknownMutationOutcome(
  resolutions: readonly MutationEpisodeResolution[],
  input: {
    resolutionId: string;
    hostCallId: string;
    resolvedAt: string;
    resolvingRuntimeInstanceId: string;
    resolvingLeaseGeneration: number;
  },
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
      // An unobservable outcome never becomes eligible evidence by being
      // bound: the host produced no normative signal, so there is nothing to
      // bind. It stays blocking until an unknown-outcome resolution is
      // appended, which in turn forces a fresh worktree recapture.
      if (episode.outcome === 'unknown') return episode;
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

/**
 * True when a host mutation has either not completed without an append-only
 * unknown-outcome resolution, or has completed without being bound to an
 * implementation digest. Final evidence approval must not advance while either
 * condition can make its reviewed subject stale.
 */
export function countUnboundMutationEpisodes(
  episodes: readonly MutationEpisode[],
  resolutions: readonly MutationEpisodeResolution[] = [],
): number {
  const resolvedCallIds = new Set(resolutions.map((resolution) => resolution.hostCallId));
  return episodes.filter(
    (episode) =>
      (episode.status === 'dispatch_authorized' && !resolvedCallIds.has(episode.hostCallId)) ||
      (episode.status === 'completed' &&
        episode.implementationDigest === null &&
        !resolvedCallIds.has(episode.hostCallId)),
  ).length;
}

/**
 * Relational state invariants for mutation episodes and the recovery fencing
 * authority (#852), enforced by the SessionState schema boundary:
 * - episode hostCallIds are unique (durable dispatch identity);
 * - a resolution must reference an EXISTING `dispatch_authorized` episode;
 * - at most one resolution per episode (append-only identity);
 * - the resolution must durably prove a LATER resolving lease generation
 *   than the episode's authorizing generation — never a mere process
 *   identity claim.
 *
 * @returns true when an issue was added (the caller must stop immediately —
 *          the schema contract is one-issue-at-a-time fail-closed).
 */
export function enforceMutationEpisodeInvariants(
  episodes: readonly MutationEpisode[],
  resolutions: readonly MutationEpisodeResolution[],
  context: z.RefinementCtx,
): boolean {
  const seenMutationCallIds = new Set<string>();
  for (const episode of episodes) {
    if (seenMutationCallIds.has(episode.hostCallId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mutationEpisodes'],
        message: `duplicate mutation episode hostCallId: ${episode.hostCallId}`,
      });
      return true;
    }
    seenMutationCallIds.add(episode.hostCallId);
  }
  const seenResolutionCallIds = new Set<string>();
  for (const resolution of resolutions) {
    const episode = episodes.find((candidate) => candidate.hostCallId === resolution.hostCallId);
    // Resolvable episodes are those whose outcome cannot be established: the
    // After-hook never ran (`dispatch_authorized`), or it ran without a
    // normative host signal (`completed` with an `unknown` outcome). Both are
    // unobservable outcomes and both must have a recovery path — otherwise the
    // unobservable state would be terminal.
    const resolvable =
      episode !== undefined &&
      (episode.status === 'dispatch_authorized' ||
        (episode.status === 'completed' && episode.outcome === 'unknown'));
    if (!resolvable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mutationEpisodeResolutions'],
        message: `mutation episode resolution references a missing or already-observed episode: ${resolution.hostCallId}`,
      });
      return true;
    }
    if (seenResolutionCallIds.has(resolution.hostCallId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mutationEpisodeResolutions'],
        message: `duplicate mutation episode resolution hostCallId: ${resolution.hostCallId}`,
      });
      return true;
    }
    seenResolutionCallIds.add(resolution.hostCallId);
    if (resolution.resolvingLeaseGeneration <= episode.leaseGeneration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mutationEpisodeResolutions'],
        message:
          `resolution for ${resolution.hostCallId} carries lease generation ` +
          `${resolution.resolvingLeaseGeneration} which does not supersede the ` +
          `episode's authorizing generation ${episode.leaseGeneration}`,
      });
      return true;
    }
  }
  return false;
}

export function hasUnboundMutationEpisodes(
  episodes: readonly MutationEpisode[],
  resolutions: readonly MutationEpisodeResolution[] = [],
): boolean {
  return countUnboundMutationEpisodes(episodes, resolutions) > 0;
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
 *
 * The parameter is deliberately narrowed to the generation alone. It used to
 * also require `holderRuntimeInstanceId`, which was never read — signalling a
 * holder-identity check that does not exist and must not exist here, since a
 * different process identity is precisely what does NOT establish authority.
 */
export function canResolveMutationEpisode(
  episode: MutationEpisode,
  currentLease: { readonly generation: number },
): ResolveMutationEpisodeDecision {
  if (currentLease.generation <= episode.leaseGeneration) {
    return { kind: 'blocked', code: 'MUTATION_EPISODE_RUNTIME_EPOCH_ACTIVE' };
  }
  return { kind: 'allow' };
}
