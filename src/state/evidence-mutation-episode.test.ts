import { describe, expect, it } from 'vitest';
import {
  authorizeMutationEpisode,
  canResolveMutationEpisode,
  completeMutationEpisode,
  hasUnresolvedMutationEpisodes,
  latestUnknownOutcomeResolvedAt,
  reconcileMutationEpisodes,
  resolveUnknownMutationOutcome,
} from './evidence-mutation-episode.js';

const ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ID = '00000000-0000-4000-8000-000000000002';
const RUNTIME_A = '00000000-0000-4000-8000-00000000000a';
const RUNTIME_B = '00000000-0000-4000-8000-00000000000b';
const TIME = '2026-01-01T00:00:00.000Z';

describe('mutation episode evidence', () => {
  it('authorizes one episode per hostCallId', () => {
    const result = authorizeMutationEpisode([], {
      episodeId: ID,
      hostCallId: 'call-1',
      toolName: 'edit',
      runtimeInstanceId: RUNTIME_A,
      authorizedAt: TIME,
    });
    expect(result.kind).toBe('authorized');
    if (result.kind !== 'authorized') return;
    expect(result.episodes).toHaveLength(1);
    expect(hasUnresolvedMutationEpisodes(result.episodes)).toBe(true);
  });

  it('blocks a replayed hostCallId instead of treating it as idempotent', () => {
    const first = authorizeMutationEpisode([], {
      episodeId: ID,
      hostCallId: 'call-1',
      toolName: 'edit',
      runtimeInstanceId: RUNTIME_A,
      authorizedAt: TIME,
    });
    if (first.kind !== 'authorized') throw new Error('unexpected replay');
    const replay = authorizeMutationEpisode(first.episodes, {
      episodeId: SECOND_ID,
      hostCallId: 'call-1',
      toolName: 'edit',
      runtimeInstanceId: RUNTIME_A,
      authorizedAt: TIME,
    });
    expect(replay.kind).toBe('replay_blocked');
    if (replay.kind === 'replay_blocked') {
      expect(replay.existing.episodeId).toBe(ID);
      expect(first.episodes).toHaveLength(1);
    }
  });

  it('binds completed success, failure, and unknown outcomes and stales historical evidence', () => {
    const first = authorizeMutationEpisode([], {
      episodeId: ID,
      hostCallId: 'call-1',
      toolName: 'edit',
      runtimeInstanceId: RUNTIME_A,
      authorizedAt: TIME,
    });
    const second = authorizeMutationEpisode(first.kind === 'authorized' ? first.episodes : [], {
      episodeId: SECOND_ID,
      hostCallId: 'call-2',
      toolName: 'bash',
      runtimeInstanceId: RUNTIME_A,
      authorizedAt: TIME,
    });
    const episodes = second.kind === 'authorized' ? second.episodes : [];
    const completed = completeMutationEpisode(
      completeMutationEpisode(episodes, 'call-1', TIME, 'failure'),
      'call-2',
      TIME,
      'unknown',
    );
    const bound = reconcileMutationEpisodes(completed, [], 'implementation-1');
    expect(bound).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'completed',
          outcome: 'failure',
          implementationDigest: 'implementation-1',
          evidenceStatus: 'eligible',
        }),
        expect.objectContaining({
          status: 'completed',
          outcome: 'unknown',
          implementationDigest: 'implementation-1',
          evidenceStatus: 'eligible',
        }),
      ]),
    );

    const reconciled = reconcileMutationEpisodes(bound, [], 'implementation-2');
    expect(reconciled[0]?.evidenceStatus).toBe('stale');
  });

  it('resolved unknown-outcome episodes never bind and stay append-only', () => {
    const first = authorizeMutationEpisode([], {
      episodeId: ID,
      hostCallId: 'call-1',
      toolName: 'bash',
      runtimeInstanceId: RUNTIME_A,
      authorizedAt: TIME,
    });
    const episodes = first.kind === 'authorized' ? first.episodes : [];
    expect(hasUnresolvedMutationEpisodes(episodes)).toBe(true);

    const resolutions = resolveUnknownMutationOutcome([], {
      resolutionId: '00000000-0000-4000-8000-000000000099',
      hostCallId: 'call-1',
      resolvedAt: TIME,
    });
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      status: 'reconciled_after_unknown_outcome',
      basis: 'worktree_recapture',
    });
    expect(latestUnknownOutcomeResolvedAt(resolutions)).toBe(TIME);

    // Resolution unblocks /implement.
    expect(hasUnresolvedMutationEpisodes(episodes, resolutions)).toBe(false);
    // The dispatch_authorized episode itself is unchanged.
    expect(episodes[0]?.status).toBe('dispatch_authorized');

    // A resolved episode is never bound to implementation evidence.
    const completed = completeMutationEpisode(episodes, 'call-1', TIME, 'unknown');
    const bound = reconcileMutationEpisodes(completed, resolutions, 'implementation-1');
    expect(bound[0]).toMatchObject({
      status: 'completed',
      implementationDigest: null,
      evidenceStatus: 'ineligible',
    });

    // Append-only: resolving the same hostCallId twice is a no-op, never a rewrite.
    const again = resolveUnknownMutationOutcome(resolutions, {
      resolutionId: '00000000-0000-4000-8000-000000000098',
      hostCallId: 'call-1',
      resolvedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(again).toEqual(resolutions);
  });

  it('blocks unknown-outcome resolution from the runtime instance that dispatched the call', () => {
    const first = authorizeMutationEpisode([], {
      episodeId: ID,
      hostCallId: 'call-1',
      toolName: 'bash',
      runtimeInstanceId: RUNTIME_A,
      authorizedAt: TIME,
    });
    const episode = first.kind === 'authorized' ? first.episodes[0]! : null!;

    // Same runtime instance: the call may simply still be running.
    expect(canResolveMutationEpisode(episode, RUNTIME_A)).toEqual({
      kind: 'blocked',
      code: 'MUTATION_EPISODE_RUNTIME_EPOCH_ACTIVE',
    });

    // A subsequent runtime instance (restart) may resolve.
    expect(canResolveMutationEpisode(episode, RUNTIME_B)).toEqual({ kind: 'allow' });
  });
});
