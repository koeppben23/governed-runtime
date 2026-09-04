import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  authorizeMutationEpisode,
  canResolveMutationEpisode,
  completeMutationEpisode,
  countUnboundMutationEpisodes,
  enforceMutationEpisodeInvariants,
  hasUnboundMutationEpisodes,
  hasUnresolvedMutationEpisodes,
  latestUnknownOutcomeResolvedAt,
  reconcileMutationEpisodes,
  resolveUnknownMutationOutcome,
  MutationEpisode,
  type MutationEpisodeResolution,
} from './evidence-mutation-episode.js';
import { makeProgressedState } from '../fixtures.js';
import { SessionState } from './schema.js';

const ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ID = '00000000-0000-4000-8000-000000000002';
const RUNTIME_A = '00000000-0000-4000-8000-00000000000a';
const RUNTIME_B = '00000000-0000-4000-8000-00000000000b';
const LEASE_17 = { holderRuntimeInstanceId: RUNTIME_A, generation: 17 };
const LEASE_18 = { holderRuntimeInstanceId: RUNTIME_B, generation: 18 };
const TIME = '2026-01-01T00:00:00.000Z';

describe('mutation episode evidence', () => {
  it('authorizes one episode per hostCallId', () => {
    const result = authorizeMutationEpisode([], {
      episodeId: ID,
      hostCallId: 'call-1',
      toolName: 'edit',
      runtimeInstanceId: RUNTIME_A,
      leaseGeneration: 17,
      authorizedAt: TIME,
    });
    expect(result.kind).toBe('authorized');
    if (result.kind !== 'authorized') return;
    expect(result.episodes).toHaveLength(1);
    expect(hasUnresolvedMutationEpisodes(result.episodes)).toBe(true);
    expect(hasUnboundMutationEpisodes(result.episodes)).toBe(true);
  });

  it('blocks a replayed hostCallId instead of treating it as idempotent', () => {
    const first = authorizeMutationEpisode([], {
      episodeId: ID,
      hostCallId: 'call-1',
      toolName: 'edit',
      runtimeInstanceId: RUNTIME_A,
      leaseGeneration: 17,
      authorizedAt: TIME,
    });
    if (first.kind !== 'authorized') throw new Error('unexpected replay');
    const replay = authorizeMutationEpisode(first.episodes, {
      episodeId: SECOND_ID,
      hostCallId: 'call-1',
      toolName: 'edit',
      runtimeInstanceId: RUNTIME_A,
      leaseGeneration: 17,
      authorizedAt: TIME,
    });
    expect(replay.kind).toBe('replay_blocked');
    if (replay.kind === 'replay_blocked') {
      expect(replay.existing.episodeId).toBe(ID);
      expect(first.episodes).toHaveLength(1);
    }
  });

  it('binds observed outcomes but never an unobservable one', () => {
    const first = authorizeMutationEpisode([], {
      episodeId: ID,
      hostCallId: 'call-1',
      toolName: 'edit',
      runtimeInstanceId: RUNTIME_A,
      leaseGeneration: 17,
      authorizedAt: TIME,
    });
    const second = authorizeMutationEpisode(first.kind === 'authorized' ? first.episodes : [], {
      episodeId: SECOND_ID,
      hostCallId: 'call-2',
      toolName: 'bash',
      runtimeInstanceId: RUNTIME_A,
      leaseGeneration: 17,
      authorizedAt: TIME,
    });
    const episodes = second.kind === 'authorized' ? second.episodes : [];
    const completed = completeMutationEpisode(
      completeMutationEpisode(episodes, 'call-1', 'edit', TIME, 'failure'),
      'call-2',
      'bash',
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
        // An unobservable outcome carries no host signal to bind. It stays
        // unbound and ineligible instead of being laundered into evidence
        // that looks identical to a confirmed success.
        expect.objectContaining({
          status: 'completed',
          outcome: 'unknown',
          implementationDigest: null,
          evidenceStatus: 'ineligible',
        }),
      ]),
    );

    const reconciled = reconcileMutationEpisodes(bound, [], 'implementation-2');
    expect(reconciled[0]?.evidenceStatus).toBe('stale');
    // The unknown-outcome episode keeps blocking until it is resolved.
    expect(hasUnboundMutationEpisodes(bound)).toBe(true);
  });

  it('makes eligible evidence from an unobservable outcome unrepresentable (BAD)', () => {
    // The defect this guards: a `completed` episode with outcome `unknown`
    // bound to a digest and marked `eligible` is byte-for-byte
    // indistinguishable from a confirmed success, so every downstream gate
    // treats a missing host signal as proof of success. The schema rejects the
    // shape itself, so no present or future write path can construct it.
    const base = {
      episodeId: '00000000-0000-4000-8000-000000000001',
      hostCallId: 'call-1',
      toolName: 'bash',
      runtimeInstanceId: RUNTIME_A,
      leaseGeneration: 17,
      authorizedAt: TIME,
      status: 'completed' as const,
      completedAt: TIME,
      outcome: 'unknown' as const,
    };
    expect(
      MutationEpisode.safeParse({
        ...base,
        implementationDigest: 'implementation-1',
        evidenceStatus: 'eligible',
      }).success,
    ).toBe(false);
    expect(
      MutationEpisode.safeParse({ ...base, implementationDigest: null, evidenceStatus: 'eligible' })
        .success,
    ).toBe(false);
    expect(
      MutationEpisode.safeParse({
        ...base,
        implementationDigest: 'implementation-1',
        evidenceStatus: 'stale',
      }).success,
    ).toBe(false);
    // The only admissible shape for an unobservable outcome.
    expect(
      MutationEpisode.safeParse({
        ...base,
        implementationDigest: null,
        evidenceStatus: 'ineligible',
      }).success,
    ).toBe(true);
    // An observed outcome is unaffected.
    expect(
      MutationEpisode.safeParse({
        ...base,
        outcome: 'success',
        implementationDigest: 'implementation-1',
        evidenceStatus: 'eligible',
      }).success,
    ).toBe(true);
  });

  it('resolved unknown-outcome episodes never bind and stay append-only', () => {
    const first = authorizeMutationEpisode([], {
      episodeId: ID,
      hostCallId: 'call-1',
      toolName: 'bash',
      runtimeInstanceId: RUNTIME_A,
      leaseGeneration: 17,
      authorizedAt: TIME,
    });
    const episodes = first.kind === 'authorized' ? first.episodes : [];
    expect(hasUnresolvedMutationEpisodes(episodes)).toBe(true);

    const resolutions = resolveUnknownMutationOutcome([], {
      resolutionId: '00000000-0000-4000-8000-000000000099',
      hostCallId: 'call-1',
      resolvedAt: TIME,
      resolvingRuntimeInstanceId: RUNTIME_B,
      resolvingLeaseGeneration: 18,
    });
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      status: 'reconciled_after_unknown_outcome',
      basis: 'worktree_recapture',
      resolvingRuntimeInstanceId: RUNTIME_B,
      resolvingLeaseGeneration: 18,
    });
    expect(latestUnknownOutcomeResolvedAt(resolutions)).toBe(TIME);

    // Resolution unblocks /implement.
    expect(hasUnresolvedMutationEpisodes(episodes, resolutions)).toBe(false);
    // The same resolution also makes the historical dispatch non-blocking for
    // final approval; fresh evidence is enforced by the revalidation authority.
    expect(hasUnboundMutationEpisodes(episodes, resolutions)).toBe(false);
    // The dispatch_authorized episode itself is unchanged.
    expect(episodes[0]?.status).toBe('dispatch_authorized');

    // A resolved episode is never bound to implementation evidence.
    const completed = completeMutationEpisode(episodes, 'call-1', 'bash', TIME, 'unknown');
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
      resolvingRuntimeInstanceId: RUNTIME_B,
      resolvingLeaseGeneration: 19,
    });
    expect(again).toEqual(resolutions);
  });

  it('blocks unknown-outcome resolution without a later lease generation', () => {
    const first = authorizeMutationEpisode([], {
      episodeId: ID,
      hostCallId: 'call-1',
      toolName: 'bash',
      runtimeInstanceId: RUNTIME_A,
      leaseGeneration: 17,
      authorizedAt: TIME,
    });
    const episode = first.kind === 'authorized' ? first.episodes[0]! : null!;

    // Same runtime instance: the call may simply still be running.
    expect(canResolveMutationEpisode(episode, LEASE_17)).toEqual({
      kind: 'blocked',
      code: 'MUTATION_EPISODE_RUNTIME_EPOCH_ACTIVE',
    });
    expect(canResolveMutationEpisode(episode, { generation: 16 })).toEqual({
      kind: 'blocked',
      code: 'MUTATION_EPISODE_RUNTIME_EPOCH_ACTIVE',
    });
    expect(canResolveMutationEpisode(episode, LEASE_18)).toEqual({ kind: 'allow' });
  });

  it('only completes the matching authorized dispatch', () => {
    const authorized = [authorizedEpisode('call-1'), authorizedEpisode('call-2')];
    const completed = completeMutationEpisode(authorized, 'call-1', 'bash', TIME, 'success');
    const unchanged = completeMutationEpisode(completed, 'call-1', 'bash', TIME, 'failure');

    expect(completed[0]).toMatchObject({ status: 'completed', outcome: 'success' });
    expect(completed[1]).toBe(authorized[1]);
    expect(completeMutationEpisode(authorized, 'call-1', 'edit', TIME, 'success')).toEqual(
      authorized,
    );
    expect(completeMutationEpisode(authorized, 'missing', 'bash', TIME, 'success')).toEqual(
      authorized,
    );
    expect(unchanged).toEqual(completed);
  });

  it('distinguishes every reconciliation evidence state', () => {
    const authorized = authorizedEpisode('authorized');
    const unknown = completeMutationEpisode(
      [authorizedEpisode('unknown')],
      'unknown',
      'bash',
      TIME,
      'unknown',
    )[0]!;
    const unbound = completeMutationEpisode(
      [authorizedEpisode('unbound')],
      'unbound',
      'bash',
      TIME,
      'success',
    )[0]!;
    const eligible = {
      ...unbound,
      implementationDigest: 'old',
      evidenceStatus: 'eligible' as const,
    };
    const stale = { ...unbound, implementationDigest: 'old', evidenceStatus: 'stale' as const };
    const resolved = { ...eligible, hostCallId: 'resolved' };
    const result = reconcileMutationEpisodes(
      [authorized, unknown, unbound, eligible, stale, resolved],
      [resolutionFor('resolved', 18)],
      'new',
    );

    expect(result[0]).toBe(authorized);
    expect(result[1]).toBe(unknown);
    expect(result[2]).toMatchObject({ implementationDigest: 'new', evidenceStatus: 'eligible' });
    expect(result[3]).toMatchObject({ implementationDigest: 'old', evidenceStatus: 'stale' });
    expect(result[4]).toBe(stale);
    expect(result[5]).toMatchObject({ implementationDigest: 'old', evidenceStatus: 'stale' });
    expect(reconcileMutationEpisodes([resolved], [resolutionFor('resolved', 18)], 'old')[0]).toBe(
      resolved,
    );
  });

  it('counts and resolves blocking episodes independently of non-blocking evidence', () => {
    const authorized = authorizedEpisode('authorized');
    const unbound = completeMutationEpisode(
      [authorizedEpisode('unbound')],
      'unbound',
      'bash',
      TIME,
      'failure',
    )[0]!;
    const bound = reconcileMutationEpisodes([unbound], [], 'digest')[0]!;
    const resolutions = [resolutionFor('authorized', 18)];

    expect(countUnboundMutationEpisodes([authorized, unbound, bound])).toBe(2);
    expect(countUnboundMutationEpisodes([authorized, unbound, bound], resolutions)).toBe(1);
    expect(hasUnresolvedMutationEpisodes([authorized, unbound, bound], resolutions)).toBe(false);
    expect(hasUnboundMutationEpisodes([authorized, unbound, bound], resolutions)).toBe(true);
    expect(latestUnknownOutcomeResolvedAt([])).toBeNull();
    expect(
      latestUnknownOutcomeResolvedAt([
        { ...resolutionFor('first', 18), resolvedAt: '2026-01-01T00:00:00.000Z' },
        { ...resolutionFor('last', 18), resolvedAt: '2026-02-01T00:00:00.000Z' },
        { ...resolutionFor('middle', 18), resolvedAt: '2026-01-15T00:00:00.000Z' },
      ]),
    ).toBe('2026-02-01T00:00:00.000Z');
  });
});

// ─── Schema-boundary invariants (enforceMutationEpisodeInvariants) ──────────────

function authorizedEpisode(hostCallId: string, leaseGeneration = 17): MutationEpisode {
  const result = authorizeMutationEpisode([], {
    episodeId: crypto.randomUUID(),
    hostCallId,
    toolName: 'bash',
    runtimeInstanceId: RUNTIME_A,
    leaseGeneration,
    authorizedAt: TIME,
  });
  return (result as { episodes: MutationEpisode[] }).episodes[0]!;
}

function resolutionFor(
  hostCallId: string,
  resolvingLeaseGeneration: number,
): MutationEpisodeResolution {
  return {
    resolutionId: crypto.randomUUID(),
    hostCallId,
    status: 'reconciled_after_unknown_outcome',
    basis: 'worktree_recapture',
    resolvedAt: '2026-01-15T00:00:00.000Z',
    resolvingRuntimeInstanceId: RUNTIME_B,
    resolvingLeaseGeneration,
  };
}

function makeContext(): { ctx: z.RefinementCtx; issues: string[] } {
  const issues: string[] = [];
  const ctx = {
    addIssue: (issue: { message?: string }) => {
      issues.push(issue.message ?? '');
    },
  } as unknown as z.RefinementCtx;
  return { ctx, issues };
}

describe('enforceMutationEpisodeInvariants (schema boundary)', () => {
  it('accepts a valid episode + fenced resolution (HAPPY)', () => {
    const episode = authorizedEpisode('call-1');
    const resolution = resolutionFor('call-1', 18);
    const { ctx, issues } = makeContext();
    expect(enforceMutationEpisodeInvariants([episode], [resolution], ctx)).toBe(false);
    expect(issues).toEqual([]);
  });

  it('rejects duplicate episode hostCallIds (BAD)', () => {
    const episode = authorizedEpisode('call-1');
    const { ctx, issues } = makeContext();
    expect(enforceMutationEpisodeInvariants([episode, episode], [], ctx)).toBe(true);
    expect(issues[0]).toContain('duplicate mutation episode hostCallId');
  });

  it('rejects a resolution without a matching episode (BAD)', () => {
    const resolution = resolutionFor('ghost-call', 18);
    const { ctx, issues } = makeContext();
    expect(enforceMutationEpisodeInvariants([], [resolution], ctx)).toBe(true);
    expect(issues[0]).toContain('missing or already-observed episode');
  });

  it('accepts a resolution for a completed episode with an unobservable outcome (HAPPY)', () => {
    // The After-hook ran but the host returned no normative signal. That is
    // just as unobservable as a dispatch that never reported back, so it must
    // have the same recovery path — otherwise the state would be terminal.
    const episode = completeMutationEpisode(
      [authorizedEpisode('call-1')],
      'call-1',
      'bash',
      TIME,
      'unknown',
    );
    const { ctx, issues } = makeContext();
    expect(enforceMutationEpisodeInvariants(episode, [resolutionFor('call-1', 18)], ctx)).toBe(
      false,
    );
    expect(issues).toEqual([]);
  });

  it('rejects a resolution for an episode whose outcome was actually observed (BAD)', () => {
    const episode = completeMutationEpisode(
      [authorizedEpisode('call-1')],
      'call-1',
      'bash',
      TIME,
      'success',
    );
    const { ctx, issues } = makeContext();
    expect(enforceMutationEpisodeInvariants(episode, [resolutionFor('call-1', 18)], ctx)).toBe(
      true,
    );
    expect(issues[0]).toContain('missing or already-observed episode');
  });

  it('rejects duplicate resolutions for one episode (BAD)', () => {
    const episode = authorizedEpisode('call-1');
    const { ctx, issues } = makeContext();
    expect(
      enforceMutationEpisodeInvariants(
        [episode],
        [resolutionFor('call-1', 18), resolutionFor('call-1', 19)],
        ctx,
      ),
    ).toBe(true);
    expect(issues[0]).toContain('duplicate mutation episode resolution');
  });

  it('rejects a resolution whose lease generation does not supersede the episode (BAD)', () => {
    const episode = authorizedEpisode('call-1', 17);
    const { ctx, issues } = makeContext();
    expect(enforceMutationEpisodeInvariants([episode], [resolutionFor('call-1', 17)], ctx)).toBe(
      true,
    );
    expect(issues[0]).toContain('does not supersede');
  });

  it.each([
    [
      'duplicate episode identity',
      () => {
        const episode = authorizedEpisode('duplicate');
        return [episode, episode];
      },
      [],
    ],
    ['missing episode', () => [], [resolutionFor('missing', 18)]],
    [
      'observed outcome',
      () =>
        completeMutationEpisode(
          [authorizedEpisode('observed')],
          'observed',
          'bash',
          TIME,
          'failure',
        ),
      [resolutionFor('observed', 18)],
    ],
    [
      'duplicate resolution identity',
      () => [authorizedEpisode('duplicate-resolution')],
      [resolutionFor('duplicate-resolution', 18), resolutionFor('duplicate-resolution', 19)],
    ],
    [
      'equal fencing generation',
      () => [authorizedEpisode('equal', 17)],
      [resolutionFor('equal', 17)],
    ],
    [
      'older fencing generation',
      () => [authorizedEpisode('older', 17)],
      [resolutionFor('older', 16)],
    ],
  ] as const)(
    'rejects %s through the SessionState schema boundary',
    (_name, episodes, resolutions) => {
      const base = makeProgressedState('IMPLEMENTATION');
      expect(
        SessionState.safeParse({
          ...base,
          mutationEpisodes: episodes(),
          mutationEpisodeResolutions: resolutions,
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    [
      'completion timestamp',
      {
        completedAt: null,
        outcome: null,
        implementationDigest: null,
        evidenceStatus: 'ineligible',
      },
    ],
    [
      'completion outcome',
      {
        completedAt: TIME,
        outcome: null,
        implementationDigest: null,
        evidenceStatus: 'ineligible',
      },
    ],
    [
      'unbound eligible evidence',
      {
        completedAt: TIME,
        outcome: 'success',
        implementationDigest: null,
        evidenceStatus: 'eligible',
      },
    ],
    [
      'bound ineligible evidence',
      {
        completedAt: TIME,
        outcome: 'success',
        implementationDigest: 'digest',
        evidenceStatus: 'ineligible',
      },
    ],
  ] as const)('rejects completed episodes missing %s', (_name, fields) => {
    expect(
      MutationEpisode.safeParse({
        ...authorizedEpisode('completed'),
        status: 'completed',
        ...fields,
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      'completion timestamp',
      {
        completedAt: TIME,
        outcome: null,
        implementationDigest: null,
        evidenceStatus: 'ineligible',
      },
    ],
    [
      'outcome',
      {
        completedAt: null,
        outcome: 'success',
        implementationDigest: null,
        evidenceStatus: 'ineligible',
      },
    ],
    [
      'implementation digest',
      {
        completedAt: null,
        outcome: null,
        implementationDigest: 'digest',
        evidenceStatus: 'ineligible',
      },
    ],
    [
      'eligible evidence',
      { completedAt: null, outcome: null, implementationDigest: null, evidenceStatus: 'eligible' },
    ],
  ] as const)('rejects dispatch authorization carrying %s', (_name, fields) => {
    expect(MutationEpisode.safeParse({ ...authorizedEpisode('dispatch'), ...fields }).success).toBe(
      false,
    );
  });
});
