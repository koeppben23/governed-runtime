/**
 * @module evidence-mutation-episode
 * @description Canonical lifecycle records for host mutation dispatches.
 */

import { z } from 'zod';

export const MutationEpisode = z
  .object({
    episodeId: z.string().uuid(),
    hostCallId: z.string().min(1),
    toolName: z.string().min(1),
    authorizedAt: z.string().datetime(),
    status: z.enum(['dispatch_authorized', 'completed']),
    completedAt: z.string().datetime().nullable(),
    outcome: z.enum(['success', 'failure']).nullable(),
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

export function authorizeMutationEpisode(
  episodes: readonly MutationEpisode[],
  input: { episodeId: string; hostCallId: string; toolName: string; authorizedAt: string },
): MutationEpisode[] {
  if (episodes.some((episode) => episode.hostCallId === input.hostCallId)) return [...episodes];
  return [
    ...episodes,
    {
      ...input,
      status: 'dispatch_authorized',
      completedAt: null,
      outcome: null,
      implementationDigest: null,
      evidenceStatus: 'ineligible',
    },
  ];
}

export function completeMutationEpisode(
  episodes: readonly MutationEpisode[],
  hostCallId: string,
  completedAt: string,
  outcome: 'success' | 'failure',
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

/** Bind every completed unbound outcome and retain prior implementation evidence as stale. */
export function reconcileMutationEpisodes(
  episodes: readonly MutationEpisode[],
  implementationDigest: string,
): MutationEpisode[] {
  return episodes.map((episode) => {
    if (episode.status !== 'completed') return episode;
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

export function hasUnresolvedMutationEpisodes(episodes: readonly MutationEpisode[]): boolean {
  return episodes.some((episode) => episode.status === 'dispatch_authorized');
}
