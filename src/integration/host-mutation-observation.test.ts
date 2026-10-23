import { describe, expect, it } from 'vitest';
import type { Hooks } from '@opencode-ai/plugin';
import { authorizeMutationEpisode } from '../state/evidence-mutation-episode.js';
import { observeEditFailure } from './host-mutation-observation.js';

type Event = Parameters<NonNullable<Hooks['event']>>[0]['event'];
type ToolPart = Extract<
  Extract<Event, { type: 'message.part.updated' }>['properties']['part'],
  { type: 'tool' }
>;
const result = authorizeMutationEpisode([], {
  episodeId: '11111111-1111-4111-8111-111111111111',
  hostCallId: 'call-1',
  toolName: 'edit',
  runtimeInstanceId: '22222222-2222-4222-8222-222222222222',
  leaseGeneration: 1,
  authorizedAt: '2026-01-01T00:00:00.000Z',
});
if (result.kind !== 'authorized' || !result.episodes[0]) throw new Error('fixture authorization');
const episode = result.episodes[0];
const end = Date.parse(episode.authorizedAt) + 100;
function part(): ToolPart {
  return {
    id: 'part-1',
    messageID: 'message-1',
    sessionID: 'session-1',
    callID: episode.hostCallId,
    type: 'tool',
    tool: 'edit',
    state: {
      status: 'error',
      input: {},
      error: 'oldString not found',
      time: { start: end - 200, end },
    },
  };
}
function history(value: unknown = part()) {
  return [{ info: { id: 'message-1', sessionID: 'session-1', role: 'assistant' }, parts: [value] }];
}

describe('pinned host edit failure observation', () => {
  it('admits the exact SDK-shaped regular error and host completion time', () => {
    expect(observeEditFailure(history(), 'session-1', episode)).toEqual({
      kind: 'observed',
      completedAt: new Date(end).toISOString(),
    });
  });
  it('admits explicit false markers and an execution ending exactly at authorization', () => {
    const value = part();
    const time = Date.parse(episode.authorizedAt);
    expect(
      observeEditFailure(
        history({
          ...value,
          metadata: { providerExecuted: false },
          state: {
            ...value.state,
            metadata: { interrupted: false },
            time: { start: time, end: time },
          },
        }),
        'session-1',
        episode,
      ),
    ).toEqual({ kind: 'observed', completedAt: episode.authorizedAt });
  });

  it.each([true, 'false', null, 0])(
    'never admits interrupted marker %j, even with an end date',
    (interrupted) => {
      const value = part();
      expect(
        observeEditFailure(
          history({ ...value, state: { ...value.state, metadata: { interrupted } } }),
          'session-1',
          episode,
        ).kind,
      ).toBe('unobserved');
    },
  );

  it.each([
    { sessionID: 'foreign' },
    { messageID: 'foreign' },
    { tool: 'bash' },
    { id: '' },
    { callID: 'other-call' },
    { metadata: { providerExecuted: true } },
    { state: { status: 'running', input: {}, time: { start: end } } },
    {
      state: {
        status: 'completed',
        input: {},
        metadata: {},
        output: '',
        title: '',
        time: { start: end, end },
      },
    },
    { state: { status: 'error', input: {}, error: 'x', time: { start: end, end: end - 1 } } },
    { state: { status: 'error', input: {}, error: 'x', time: { start: 0, end: 1 } } },
    { state: { status: 'error', input: {}, error: 'x', time: { start: 0, end: Infinity } } },
  ])('rejects malformed, stale, foreign or non-terminal parts: %j', (patch) => {
    expect(observeEditFailure(history({ ...part(), ...patch }), 'session-1', episode).kind).toBe(
      'unobserved',
    );
  });

  it('rejects ambiguous call identities even if only one matching part is a valid error', () => {
    const messages = history();
    messages[0]!.parts.push({ ...part(), tool: 'bash' });
    expect(observeEditFailure(messages, 'session-1', episode).kind).toBe('unobserved');
  });

  it('does not treat another message session as a valid source', () => {
    const messages = history();
    messages[0]!.info.sessionID = 'foreign';
    expect(observeEditFailure(messages, 'session-1', episode).kind).toBe('unobserved');
  });
  it('never treats a user-owned part as an execution observation', () => {
    const messages = history();
    messages[0]!.info.role = 'user';
    expect(observeEditFailure(messages, 'session-1', episode).kind).toBe('unobserved');
  });

  it.each([undefined, {}, [], [{ parts: [part()] }]])('rejects malformed history %j', (value) => {
    expect(observeEditFailure(value, 'session-1', episode).kind).toBe('unobserved');
  });

  it.each(['bash', 'write', 'apply_patch'])(
    'does not widen the proven tool contract to %s',
    (toolName) => {
      expect(observeEditFailure(history(), 'session-1', { ...episode, toolName }).kind).toBe(
        'unobserved',
      );
    },
  );
});
