import { z } from 'zod';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { unresolvedMutationEpisodes } from '../state/evidence-mutation-episode.js';
import { observeEditFailure } from './host-mutation-observation.js';
import { commitMutationCompletion } from './plugin-mutation-episodes.js';
import { IntegrationInvariantError } from './errors.js';

const EventTrigger = z.object({
  type: z.literal('session.tool.failed'),
  data: z.object({
    sessionID: z.string().min(1),
    id: z.string().min(1),
  }),
});

/** Async events are wakeups, never a replacement for a fresh host history read. */
export async function reconcileMutationEvent(
  runtime: FlowGuardPluginRuntime,
  event: unknown,
): Promise<void> {
  const trigger = EventTrigger.safeParse(event);
  if (!trigger.success) return;
  const failed = trigger.data.data;
  await reconcileHostMutationEpisodes(runtime, failed.sessionID, failed.id);
}

/** Synchronous barrier before /implement; host I/O is deliberately outside the state write lock. */
export async function reconcileHostMutationEpisodes(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  callId?: string,
): Promise<void> {
  const resolution = await runtime.ws.resolveSessionAuthority(sessionId);
  if (resolution.status !== 'resolved') return; // The owning tool reports absent/unavailable sessions.
  const episodes = unresolvedMutationEpisodes(
    resolution.state.mutationEpisodes,
    resolution.state.mutationEpisodeResolutions,
  ).filter(
    (episode) =>
      episode.toolName === 'edit' && (callId === undefined || episode.hostCallId === callId),
  );
  if (episodes.length === 0) return;
  const client = runtime.orchestratorDeps.client;
  let history: unknown;
  try {
    history = await boundedHistoryRead(() => client.readHistory(sessionId));
  } catch (error) {
    throw new IntegrationInvariantError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      `Host mutation outcome query failed: ${error instanceof Error ? error.message : 'unavailable'}`,
    );
  }
  if (!Array.isArray(history))
    throw new IntegrationInvariantError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'Host mutation outcome history is unavailable.',
    );
  for (const episode of episodes) {
    const observation = observeEditFailure(history, sessionId, episode);
    if (observation.kind === 'unobserved') {
      runtime.log.info('mutation', 'host mutation remains unresolved', {
        sessionId,
        hostCallId: episode.hostCallId,
        reason: observation.reason,
      });
      continue;
    }
    await commitMutationCompletion({
      resolution,
      expected: episode,
      sessionId,
      now: observation.completedAt,
      outcome: 'failure',
    });
  }
}

/** A wedged host query cannot indefinitely stall /implement; late settlement has no write continuation. */
async function boundedHistoryRead<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new IntegrationInvariantError(
                'PLUGIN_ENFORCEMENT_UNAVAILABLE',
                'Host mutation outcome query timed out.',
              ),
            ),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
