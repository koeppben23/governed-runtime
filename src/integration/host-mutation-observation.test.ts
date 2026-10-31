/** Missing pinned-host terminality proof must not become API-shape acceptance. */
import { describe, expect, it } from 'vitest';
import type { SessionMessageAssistantTool } from '@opencode/client';
import { authorizeMutationEpisode } from '../state/evidence-mutation-episode.js';
import { observeEditFailure } from './host-mutation-observation.js';

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

describe('unverified native V2 edit-error observation boundary', () => {
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
      ).toMatchObject({ kind: 'unobserved', reason: expect.stringContaining('NOT_VERIFIED') });
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
