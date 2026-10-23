import { z } from 'zod';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { unresolvedMutationEpisodes } from '../state/evidence-mutation-episode.js';
import { observeEditFailure } from './host-mutation-observation.js';
import { commitMutationCompletion } from './plugin-mutation-episodes.js';
import { IntegrationInvariantError } from './errors.js';

const EventTrigger = z.object({
  type: z.literal('message.part.updated'),
  properties: z.object({
    part: z.object({
      type: z.literal('tool'),
      tool: z.literal('edit'),
      sessionID: z.string().min(1),
      callID: z.string().min(1),
      state: z.object({ status: z.literal('error') }),
    }),
  }),
});

/** Async events are wakeups, never a replacement for a fresh host history read. */
export async function reconcileMutationEvent(
  runtime: FlowGuardPluginRuntime,
  event: unknown,
): Promise<void> {
  const trigger = EventTrigger.safeParse(event);
  if (!trigger.success) return;
  const part = trigger.data.properties.part;
  await reconcileHostMutationEpisodes(runtime, part.sessionID, part.callID);
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
  const session = runtime.orchestratorDeps.client.session;
  if (typeof session.messages !== 'function')
    throw new IntegrationInvariantError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'Host message access is required to observe the open edit outcome.',
    );
  const readMessages = session.messages.bind(session);
  let response: Awaited<ReturnType<NonNullable<typeof session.messages>>>;
  try {
    response = await boundedHistoryRead(() => readMessages({ path: { id: sessionId } }));
  } catch (error) {
    throw new IntegrationInvariantError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      `Host mutation outcome query failed: ${error instanceof Error ? error.message : 'unavailable'}`,
    );
  }
  if (response?.error || !response?.data)
    throw new IntegrationInvariantError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'Host mutation outcome history is unavailable.',
    );
  for (const episode of episodes) {
    const observation = observeEditFailure(response.data, sessionId, episode);
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
