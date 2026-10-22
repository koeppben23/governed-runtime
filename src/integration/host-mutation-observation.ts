/** Pinned OpenCode terminal-part boundary. Only real-host-proven edit failures are admitted. */
import { z } from 'zod';
import type { MutationEpisode } from '../state/evidence-mutation-episode.js';

const metadata = z.record(z.string(), z.unknown());
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const EditFailurePart = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  messageID: z.string().min(1),
  type: z.literal('tool'),
  callID: z.string().min(1),
  tool: z.literal('edit'),
  metadata: metadata.optional(),
  state: z.object({
    status: z.literal('error'),
    input: metadata,
    error: z.string().min(1),
    metadata: metadata.optional(),
    time: z.object({ start: timestamp, end: timestamp }),
  }),
});

const History = z.array(
  z.object({
    info: z.object({
      id: z.string().min(1),
      sessionID: z.string().min(1),
      role: z.enum(['user', 'assistant']),
    }),
    parts: z.array(z.unknown()),
  }),
);

export type MutationObservation =
  | { readonly kind: 'observed'; readonly completedAt: string }
  | { readonly kind: 'unobserved'; readonly reason: string };

/** Events are wakeups only. A unique, freshly host-read part is the observation authority. */
export function observeEditFailure(
  history: unknown,
  sessionId: string,
  episode: MutationEpisode,
): MutationObservation {
  if (episode.toolName !== 'edit')
    return unobserved('Tool class has no admitted terminal-part contract.');
  const parsed = History.safeParse(history);
  if (!parsed.success) return unobserved('Host message history is unavailable or malformed.');
  const candidates = parsed.data.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (
        typeof part !== 'object' ||
        part === null ||
        !('callID' in part) ||
        part.callID !== episode.hostCallId
      )
        return [];
      return [{ message, part }];
    }),
  );
  if (candidates.length !== 1) return unobserved('Host call identity is missing or ambiguous.');
  const candidate = candidates[0];
  if (!candidate) return unobserved('No host part matched.');
  const result = EditFailurePart.safeParse(candidate.part);
  if (!result.success) return unobserved('The matching host part is not a regular edit failure.');
  const part = result.data;
  return validateTerminalPart(part, candidate.message.info, sessionId, episode);
}

function validateTerminalPart(
  part: z.infer<typeof EditFailurePart>,
  message: { id: string; sessionID: string; role: 'user' | 'assistant' },
  sessionId: string,
  episode: MutationEpisode,
): MutationObservation {
  if (
    message.role !== 'assistant' ||
    part.sessionID !== sessionId ||
    message.sessionID !== sessionId ||
    part.messageID !== message.id
  )
    return unobserved('Host message/session binding mismatch.');
  if (!isAbsentOrFalse(part.metadata?.providerExecuted))
    return unobserved('Provider-executed parts are not governed host dispatches.');
  const interrupted = part.state.metadata?.interrupted;
  if (!isAbsentOrFalse(interrupted))
    return unobserved('Cleanup/interrupted parts never prove regular completion.');
  if (
    part.state.time.end < part.state.time.start ||
    part.state.time.end < Date.parse(episode.authorizedAt)
  )
    return unobserved('Host completion predates its dispatch or execution.');
  return { kind: 'observed', completedAt: new Date(part.state.time.end).toISOString() };
}

function unobserved(reason: string): MutationObservation {
  return { kind: 'unobserved', reason };
}

function isAbsentOrFalse(value: unknown): boolean {
  return value === undefined || value === false;
}
