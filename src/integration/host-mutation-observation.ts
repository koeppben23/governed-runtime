/** Exact native edit-error observation, not a message-format migration or a
 * general process/descendant-quiescence assertion. */
import { z } from 'zod';
import type { MutationEpisode } from '../state/evidence-mutation-episode.js';
import { readNativeHostCallIdentity } from './opencode-host-adapter.js';

export type MutationObservation =
  | { readonly kind: 'observed'; readonly completedAt: string }
  | { readonly kind: 'unobserved'; readonly reason: string };

const Time = z.number().int().nonnegative().max(8_640_000_000_000_000);
const FailedLocalEdit = z.object({
  type: z.literal('tool'),
  id: z.string().min(1),
  name: z.literal('edit'),
  // In V2 this flag means provider-executed, NOT whether the local tool ran.
  executed: z.literal(false),
  state: z.object({
    status: z.literal('error'),
    input: z.record(z.string(), z.unknown()),
    error: z.object({ type: z.literal('tool.execution'), message: z.string() }),
  }),
  time: z.object({ created: Time, ran: Time, completed: Time }),
});

/** Pinned 2.2.4: local typed execution failure settles the tool fiber before
 * Tool.Failed is published; cleanup/interruption publishes `aborted` instead.
 * See docs/host-probes/opencode-v2/edit-error-terminality.md for source and
 * real-host proof. Notifications/metadata/idle alone are never completion. */
export function observeEditFailure(
  history: unknown,
  sessionId: string,
  episode: MutationEpisode,
): MutationObservation {
  if (!sessionId || episode.toolName !== 'edit' || episode.status !== 'dispatch_authorized')
    return unobserved('No unresolved edit dispatch.');
  if (!Array.isArray(history)) return unobserved('Native history is unavailable.');
  const identity = readNativeHostCallIdentity(episode.hostCallId);
  if (identity === null || identity.sessionId !== sessionId)
    return unobserved('No exact current native call identity.');
  const parsed = FailedLocalEdit.safeParse(
    findExactToolPart(history, identity.messageId, identity.callId),
  );
  if (!parsed.success) return unobserved('No unique regular local edit execution failure.');
  const { created, ran, completed } = parsed.data.time;
  const authorized = Date.parse(episode.authorizedAt);
  if (!Number.isFinite(authorized) || created > ran || ran > completed || completed < authorized)
    return unobserved('Invalid or pre-authorization native completion time.');
  return { kind: 'observed', completedAt: new Date(completed).toISOString() };
}

function findExactToolPart(
  history: readonly unknown[],
  messageId: string,
  callId: string,
): unknown {
  const messages = history.filter((value) => record(value) && value.id === messageId);
  const message: unknown = messages[0];
  if (
    messages.length !== 1 ||
    !record(message) ||
    message.type !== 'assistant' ||
    !Array.isArray(message.content)
  )
    return null;
  const matches = message.content.filter((part: unknown) => record(part) && part.id === callId);
  return matches.length === 1 ? matches[0] : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unobserved(reason: string): MutationObservation {
  return {
    kind: 'unobserved',
    reason,
  };
}
