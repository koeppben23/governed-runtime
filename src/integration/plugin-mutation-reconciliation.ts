import { z } from 'zod';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { unresolvedMutationEpisodes } from '../state/evidence-mutation-episode.js';
import { observeEditFailure } from './host-mutation-observation.js';
import { commitMutationCompletion } from './plugin-mutation-episodes.js';
import { IntegrationInvariantError } from './errors.js';
import { readNativeHostCallIdentity } from './opencode-host-adapter.js';

const EventTrigger = z.object({
  type: z.literal('session.tool.failed'),
  data: z.object({ hostCallId: z.string().min(1) }),
});

/** Async events are wakeups, never a replacement for a fresh host history read.
 * The governed session owns the episode store; the projected native host call
 * identity selects the episode, including delegated-child calls. */
export async function reconcileMutationEvent(
  runtime: FlowGuardPluginRuntime,
  event: unknown,
  governedSessionId: string,
): Promise<void> {
  const trigger = EventTrigger.safeParse(event);
  if (!trigger.success) return;
  await reconcileHostMutationEpisodes(runtime, governedSessionId, trigger.data.data.hostCallId);
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
  const histories = new Map<string, unknown>();
  for (const episode of episodes) {
    const identity = readNativeHostCallIdentity(episode.hostCallId);
    if (identity === null) continue; // Historical/invalid IDs stay unresolved, never migrated.
    if (!histories.has(identity.sessionId)) {
      let history: unknown;
      try {
        history = await boundedHistoryRead(() => client.readHistory(identity.sessionId));
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
      histories.set(identity.sessionId, history);
    }
    const observation = observeEditFailure(
      histories.get(identity.sessionId),
      identity.sessionId,
      episode,
    );
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
