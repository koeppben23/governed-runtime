/**
 * @module integration/tools/reconcile-mutation-episode
 * @description flowguard_reconcile_mutation_episode — append-only
 *              unknown-outcome resolution for host mutation episodes.
 *
 * A host mutation dispatch whose After-hook never ran (crash, interruption)
 * leaves a durable `dispatch_authorized` MutationEpisode. This tool appends
 * a `reconciled_after_unknown_outcome` resolution with basis
 * `worktree_recapture`: the episode stays dispatch_authorized forever, but
 * is no longer blocking. All pre-resolution implementation, validation, and
 * review evidence is unreliable — the agent must re-record the worktree with
 * a fresh /implement, fresh checks, and a fresh review.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { formatBlocked, writeStateWithArtifacts } from './helpers.js';
import { withMutableSessionTransaction } from './helpers.js';
import { formatError } from './error-format.js';
import type { ToolDefinition } from './helpers.js';
import type { SessionState } from '../../state/schema.js';
import { resolveUnknownMutationOutcome } from '../../state/evidence-mutation-episode.js';

export const reconcile_mutation_episode: ToolDefinition = {
  description:
    'Resolve a host mutation episode whose outcome can never be observed (interrupted or ' +
    'crashed host tool call between Before- and After-hook). Appends an append-only ' +
    "resolution record (status 'reconciled_after_unknown_outcome', basis 'worktree_recapture'). " +
    'After resolution, ALL prior implementation, validation, and review evidence is ' +
    'unreliable: make the changes again, record them with flowguard_implement({}), re-run ' +
    'the checks, and submit a fresh implementation review. Use only when the host call ' +
    'outcome is truly unobservable.',
  args: {
    hostCallId: z
      .string()
      .min(1)
      .describe('The host callID of the unresolved mutation dispatch shown in /status.'),
  },
  async execute(args, context) {
    try {
      return await withMutableSessionTransaction(context, async ({ sessDir, state }) => {
        const episode = state.mutationEpisodes.find(
          (candidate) => candidate.hostCallId === args.hostCallId,
        );
        if (!episode) {
          return formatBlocked('MUTATION_EPISODE_NOT_FOUND', { hostCallId: args.hostCallId });
        }
        if (episode.status === 'completed') {
          return formatBlocked('MUTATION_EPISODE_ALREADY_COMPLETED', {
            hostCallId: args.hostCallId,
            outcome: episode.outcome ?? 'unknown',
          });
        }
        if (state.mutationEpisodeResolutions.some((r) => r.hostCallId === args.hostCallId)) {
          return formatBlocked('MUTATION_EPISODE_ALREADY_RESOLVED', {
            hostCallId: args.hostCallId,
          });
        }
        const nextState: SessionState = {
          ...state,
          mutationEpisodeResolutions: resolveUnknownMutationOutcome(
            state.mutationEpisodeResolutions,
            {
              resolutionId: randomUUID(),
              hostCallId: args.hostCallId,
              resolvedAt: new Date().toISOString(),
            },
          ),
        };
        await writeStateWithArtifacts(sessDir, nextState);
        return JSON.stringify({
          error: false,
          code: 'MUTATION_EPISODE_RESOLVED',
          hostCallId: args.hostCallId,
          status: 'reconciled_after_unknown_outcome',
          basis: 'worktree_recapture',
          next:
            'Prior implementation evidence is unreliable. Re-apply the implementation work, ' +
            'record it with /implement, re-run the checks with /check, and submit a fresh review.',
        });
      });
    } catch (err) {
      return formatError(err);
    }
  },
};
