/** Missing pinned-host terminality proof must not become API-shape acceptance. */
import { describe, expect, it } from 'vitest';
import type { SessionMessageAssistantTool } from '@opencode/client';
import { authorizeMutationEpisode } from '../state/evidence-mutation-episode.js';
import { observeEditFailure } from './host-mutation-observation.js';
import { nativeHostCallId } from './opencode-host-adapter.js';

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
const native = {
  type: 'tool',
  id: 'call-1',
  name: 'edit',
  state: {
    status: 'error',
    input: {},
    error: { type: 'tool', message: 'edit failed after partial mutation' },
  },
  time: {
    created: Date.parse(episode.authorizedAt),
    completed: Date.parse(episode.authorizedAt) + 100,
  },
} satisfies SessionMessageAssistantTool;

describe('native V2 edit-error observation boundary', () => {
  it.each([
    native,
    { ...native, executed: false },
    { ...native, executed: true },
    { ...native, state: { ...native.state, metadata: { interrupted: false } } },
    { ...native, state: { ...native.state, metadata: { interrupted: true } } },
  ])(
    'does not promote terminal-looking native content into regular completion proof: %j',
    (content) => {
      expect(
        observeEditFailure(
          [{ type: 'assistant', id: 'message-1', content: [content] }],
          'session-1',
          episode,
        ),
      ).toMatchObject({ kind: 'unobserved', reason: expect.any(String) });
    },
  );

  it.each([
    undefined,
    null,
    {},
    [],
    [{ parts: [native] }],
    [
      {
        info: { role: 'assistant', sessionID: 'session-1', id: 'message-1' },
        parts: [
          {
            type: 'tool',
            id: 'part',
            messageID: 'message-1',
            sessionID: 'session-1',
            callID: 'call-1',
            tool: 'edit',
            state: {
              status: 'error',
              input: {},
              error: 'old format',
              time: { start: 0, end: Date.now() },
            },
          },
        ],
      },
    ],
  ])('rejects malformed or removed host-history contracts: %j', (history) => {
    expect(observeEditFailure(history, 'session-1', episode).kind).toBe('unobserved');
  });

  it.each(['bash', 'write', 'apply_patch', 'edit'])(
    'never widens the admitted error-history contract to %s',
    (toolName) => {
      expect(observeEditFailure([native], 'session-1', { ...episode, toolName }).kind).toBe(
        'unobserved',
      );
    },
  );
});

const currentEpisode = {
  ...episode,
  hostCallId: nativeHostCallId('session-1', 'message-1', 'call-1'),
};
const regular = {
  ...native,
  executed: false,
  state: { ...native.state, error: { type: 'tool.execution', message: 'oldString not found' } },
  time: { ...native.time, ran: native.time.created },
};
const history = (part: unknown = regular) => [
  { type: 'assistant', id: 'message-1', content: [part] },
];

describe('pinned local edit typed-failure contract', () => {
  it('observes exactly one authorized native local edit error, not filesystem success', () => {
    expect(observeEditFailure(history(), 'session-1', currentEpisode)).toEqual({
      kind: 'observed',
      completedAt: new Date(regular.time.completed).toISOString(),
    });
  });

  it('admits equal clock ticks at authorization and completion without requiring invented elapsed time', () => {
    const instant = {
      ...regular,
      time: {
        created: regular.time.created,
        ran: regular.time.created,
        completed: regular.time.created,
      },
    };
    expect(observeEditFailure(history(instant), 'session-1', currentEpisode)).toEqual({
      kind: 'observed',
      completedAt: episode.authorizedAt,
    });
  });

  it.each([
    { ...regular, executed: true },
    { ...regular, executed: undefined },
    { ...regular, name: 'shell' },
    { ...regular, id: 'other-call' },
    { ...regular, state: { ...regular.state, status: 'running' } },
    { ...regular, state: { ...regular.state, status: 'completed' } },
    ...['aborted', 'unknown', 'tool.unknown', 'tool.result-missing', 'permission.rejected'].map(
      (type) => ({ ...regular, state: { ...regular.state, error: { type, message: 'failed' } } }),
    ),
    { ...regular, state: { ...regular.state, error: 'untyped failure' } },
    { ...regular, state: { ...regular.state, input: null } },
    { ...regular, time: { ...regular.time, ran: undefined } },
    { ...regular, time: { ...regular.time, completed: undefined } },
    { ...regular, time: { ...regular.time, completed: -1 } },
    { ...regular, time: { ...regular.time, completed: Number.NaN } },
    { ...regular, time: { ...regular.time, completed: Infinity } },
    { ...regular, time: { ...regular.time, completed: 8_640_000_000_000_001 } },
    { ...regular, time: { ...regular.time, completed: regular.time.ran - 1 } },
    { ...regular, time: { ...regular.time, created: regular.time.ran + 1 } },
    { ...regular, time: { ...regular.time, ran: regular.time.completed + 1 } },
  ])('rejects incomplete, foreign, hosted or nonregular tool states: %j', (part) => {
    expect(observeEditFailure(history(part), 'session-1', currentEpisode).kind).toBe('unobserved');
  });

  it.each([
    { ...currentEpisode, toolName: 'write' },
    { ...currentEpisode, status: 'completed' as const },
    { ...currentEpisode, hostCallId: 'call-1' },
    { ...currentEpisode, hostCallId: nativeHostCallId('session-1', 'other-message', 'call-1') },
    { ...currentEpisode, hostCallId: nativeHostCallId('other-session', 'message-1', 'call-1') },
    { ...currentEpisode, authorizedAt: 'invalid' },
    { ...currentEpisode, authorizedAt: new Date(regular.time.completed + 1).toISOString() },
  ])('rejects an inadmissible or stale episode: %j', (candidate) => {
    expect(observeEditFailure(history(), 'session-1', candidate).kind).toBe('unobserved');
  });

  it('rejects duplicate exact native calls even if one looks completed', () => {
    for (const duplicate of [regular, { ...regular, state: { status: 'running' } }]) {
      expect(
        observeEditFailure(
          [{ type: 'assistant', id: 'message-1', content: [regular, duplicate] }],
          'session-1',
          currentEpisode,
        ).kind,
      ).toBe('unobserved');
    }
    expect(observeEditFailure([...history(), ...history()], 'session-1', currentEpisode).kind).toBe(
      'unobserved',
    );
  });

  it.each([
    [],
    { data: history() },
    [{ id: 'message-1', type: 'user', content: [regular] }],
    [{ id: 'message-1', type: 'assistant', content: null }],
    [{ id: 'message-1', type: 'assistant', content: [null, {}, { ...regular, type: 'text' }] }],
    [{ id: 'other-message', type: 'assistant', content: [regular] }],
    [...history(), { id: 'message-1', type: 'assistant' }],
    [...history(), { id: 'message-1', type: 'user' }],
  ])('rejects incomplete or duplicate owning-message projections: %j', (candidate) => {
    expect(observeEditFailure(candidate, 'session-1', currentEpisode).kind).toBe('unobserved');
  });

  it('does not let caller metadata turn interrupted cleanup into a regular failure', () => {
    const interrupted = {
      ...regular,
      state: {
        ...regular.state,
        error: { type: 'aborted', message: 'Tool execution interrupted' },
        metadata: { interrupted: false, executed: true, origin: 'human' },
      },
    };
    expect(observeEditFailure(history(interrupted), 'session-1', currentEpisode).kind).toBe(
      'unobserved',
    );
  });

  it('ignores unrelated native content but never accepts text or an event as history', () => {
    const mixed = [undefined, null, 1, true, 'text', {}, { type: 'user' }, ...history()];
    expect(observeEditFailure(mixed, 'session-1', currentEpisode).kind).toBe('observed');
    expect(observeEditFailure(history(), '', currentEpisode).kind).toBe('unobserved');
    expect(
      observeEditFailure(
        [{ type: 'session.tool.failed', data: regular }],
        'session-1',
        currentEpisode,
      ).kind,
    ).toBe('unobserved');
  });
});
