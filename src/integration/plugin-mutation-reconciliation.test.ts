import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalBinding, createTestWorkspace } from './test-helpers.js';
import { makeProgressedState } from '../fixtures.js';
import { readState, writeState, PersistenceError } from '../adapters/persistence.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { writeStateWithArtifacts } from './tools/helpers.js';
import { sessionDir } from '../adapters/workspace/index.js';
import { getRuntimeInstanceId, resetRuntimeInstanceIdForTest } from './runtime-instance.js';
import { authorizeMutationEpisode } from '../state/evidence-mutation-episode.js';
import {
  reconcileHostMutationEpisodes,
  reconcileMutationEvent,
} from './plugin-mutation-reconciliation.js';
import { commitMutationCompletion } from './plugin-mutation-episodes.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import * as outbox from './audit-outbox.js';
import { acquireSessionWriteLock } from '../adapters/persistence-lock.js';
import { createReviewClient } from './opencode-v2-test-helpers.js';

let workspace: Awaited<ReturnType<typeof createTestWorkspace>>;
let sessDir: string;
let sessionId: string;
const at = '2026-10-01T00:00:00.000Z';
const completedAt = '2026-10-01T00:00:01.000Z';

beforeEach(async () => {
  workspace = await createTestWorkspace();
  sessionId = randomUUID();
  const binding = await canonicalBinding(workspace.tmpDir, sessionId);
  sessDir = sessionDir(binding.fingerprint, sessionId);
  const authorized = authorizeMutationEpisode([], {
    episodeId: randomUUID(),
    hostCallId: 'edit-call',
    toolName: 'edit',
    runtimeInstanceId: getRuntimeInstanceId(),
    leaseGeneration: 1,
    authorizedAt: at,
  });
  if (authorized.kind !== 'authorized') throw new Error('fixture');
  await writeStateWithArtifacts(sessDir, {
    ...makeProgressedState('IMPLEMENTATION'),
    binding,
    runtimeLease: {
      holderRuntimeInstanceId: getRuntimeInstanceId(),
      holderPid: process.pid,
      generation: 1,
      acquiredAt: at,
      lastHeartbeatAt: at,
    },
    mutationEpisodes: authorized.episodes,
  });
});
afterEach(async () => {
  await workspace.cleanup();
});

// Existing completion-validator fixture, not evidence that V2 context attests
// these fields. Production passes native history through without normalization;
// proving/replacing that observation contract is still an installed-host gate.
function hostHistory(interrupted?: boolean) {
  return [
    {
      info: { id: 'message', sessionID: sessionId, role: 'assistant' },
      parts: [
        {
          type: 'tool',
          id: 'part',
          messageID: 'message',
          sessionID: sessionId,
          callID: 'edit-call',
          tool: 'edit',
          state: {
            status: 'error',
            input: {},
            error: 'failed edit',
            metadata: interrupted === undefined ? {} : { interrupted },
            time: { start: Date.parse(at), end: Date.parse(completedAt) },
          },
        },
      ],
    },
  ];
}

function runtime(messages = vi.fn(async (): Promise<unknown> => hostHistory())) {
  return {
    value: {
      ws: {
        resolveSessionAuthority: () =>
          resolveSessionAuthority({ root: workspace.tmpDir, sessionId }),
      },
      orchestratorDeps: { client: createReviewClient({ readHistory: messages }) },
      log: { info: vi.fn() },
    } as unknown as FlowGuardPluginRuntime,
    messages,
  };
}

async function completionInput() {
  const resolution = await resolveSessionAuthority({ root: workspace.tmpDir, sessionId });
  if (resolution.status !== 'resolved' || !resolution.state.mutationEpisodes[0])
    throw new Error('fixture');
  return {
    resolution,
    expected: resolution.state.mutationEpisodes[0],
    sessionId,
    now: completedAt,
    outcome: 'failure' as const,
  };
}

describe('mutation completion authority and reconciliation', () => {
  it('ignores old event envelopes instead of translating them into native wakeups', async () => {
    const host = runtime();
    await reconcileMutationEvent(host.value, {
      type: 'message.part.updated',
      properties: { part: hostHistory()[0]!.parts[0] },
    });
    expect(host.messages).not.toHaveBeenCalled();
    expect((await readState(sessDir))!.mutationEpisodes[0]!.status).toBe('dispatch_authorized');
  });

  it('rejects a missing host response as a typed boundary failure', async () => {
    const host = runtime(vi.fn().mockResolvedValue(undefined));
    await expect(reconcileHostMutationEpisodes(host.value, sessionId)).rejects.toMatchObject({
      code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    });
    expect((await readState(sessDir))!.mutationEpisodes[0]!.status).toBe('dispatch_authorized');
  });
  it('does not query host history for unadmitted tools or unrelated call IDs', async () => {
    const host = runtime();
    await reconcileHostMutationEpisodes(host.value, sessionId, 'unrelated-call');
    expect(host.messages).not.toHaveBeenCalled();
    const state = (await readState(sessDir))!;
    await writeState(sessDir, {
      ...state,
      mutationEpisodes: state.mutationEpisodes.map((episode) => ({ ...episode, toolName: 'bash' })),
    });
    await reconcileHostMutationEpisodes(host.value, sessionId);
    expect(host.messages).not.toHaveBeenCalled();
  });

  it('cancels the observation deadline after a successful read', async () => {
    const host = runtime(
      vi.fn(async () => {
        vi.useFakeTimers();
        return hostHistory();
      }),
    );
    try {
      await reconcileHostMutationEpisodes(host.value, sessionId);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects the exact authorized dispatch when another episode precedes it', async () => {
    const input = await completionInput();
    await writeState(sessDir, {
      ...input.resolution.state,
      mutationEpisodes: [
        { ...input.expected, episodeId: randomUUID(), hostCallId: 'earlier-call' },
        input.expected,
      ],
    });
    await commitMutationCompletion(input);
    expect((await readState(sessDir))!.mutationEpisodes.map((episode) => episode.status)).toEqual([
      'dispatch_authorized',
      'completed',
    ]);
  });

  it('does not let a resolution for another call suppress a valid completion', async () => {
    const input = await completionInput();
    await writeState(sessDir, {
      ...input.resolution.state,
      mutationEpisodes: [
        input.expected,
        { ...input.expected, episodeId: randomUUID(), hostCallId: 'resolved-other' },
      ],
      mutationEpisodeResolutions: [
        {
          resolutionId: randomUUID(),
          hostCallId: 'resolved-other',
          status: 'reconciled_after_unknown_outcome',
          basis: 'worktree_recapture',
          resolvedAt: completedAt,
          resolvingRuntimeInstanceId: randomUUID(),
          resolvingLeaseGeneration: 2,
        },
      ],
    });
    expect(await commitMutationCompletion(input)).toBe('completed');
    expect((await readState(sessDir))!.mutationEpisodes[0]!.status).toBe('completed');
  });
  it.each(['absent', 'future-generation', 'wrong-authorizer'])(
    'rejects invalid lease provenance: %s',
    async (kind) => {
      const input = await completionInput();
      const expected = {
        ...input.expected,
        ...(kind === 'future-generation' ? { leaseGeneration: 2 } : {}),
        ...(kind === 'wrong-authorizer' ? { runtimeInstanceId: randomUUID() } : {}),
      };
      await writeState(sessDir, {
        ...input.resolution.state,
        mutationEpisodes: [expected],
        ...(kind === 'absent' ? { runtimeLease: null } : {}),
      });
      await expect(commitMutationCompletion({ ...input, expected })).rejects.toMatchObject({
        code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      });
      expect((await readState(sessDir))!.mutationEpisodes[0]!.status).toBe('dispatch_authorized');
    },
  );

  it('requires a readable semantic history only when an admitted edit episode needs observation', async () => {
    const host = runtime();
    host.value.orchestratorDeps.client.readHistory = vi
      .fn()
      .mockRejectedValue(new Error('unavailable'));
    await expect(reconcileHostMutationEpisodes(host.value, sessionId)).rejects.toMatchObject({
      code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    });
    await expect(
      reconcileMutationEvent(host.value, {
        type: 'session.tool.failed',
        data: { sessionID: sessionId, id: 'unrelated-call' },
      }),
    ).resolves.toBeUndefined();
  });
  it('times out a wedged host read and never writes on its later settlement', async () => {
    let release: (value: unknown) => void = () => {};
    let entered: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const host = runtime(
      vi.fn(() => {
        vi.useFakeTimers();
        entered();
        return new Promise<unknown>((resolve) => {
          release = resolve;
        });
      }),
    );
    const pending = reconcileHostMutationEpisodes(host.value, sessionId);
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    });
    try {
      await ready;
      await vi.advanceTimersByTimeAsync(5_001);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
    release(hostHistory());
    expect((await readState(sessDir))!.mutationEpisodes[0]!.status).toBe('dispatch_authorized');
  });

  it('decides from state committed while it waited for the actual write lock', async () => {
    const input = await completionInput();
    const lock = await acquireSessionWriteLock(sessDir);
    const pending = commitMutationCompletion(input);
    try {
      await outbox.writeStateWithAuditOperationsAlreadyLocked(sessDir, {
        ...input.resolution.state,
        mutationEpisodes: [
          { ...input.expected, status: 'completed', outcome: 'success', completedAt },
        ],
      });
    } finally {
      await lock.release();
    }
    expect(await pending).toBe('unchanged');
    expect((await readState(sessDir))!.mutationEpisodes[0]!.outcome).toBe('success');
  });

  it.each(['session', 'worktree', 'fingerprint', 'flowguard-session'])(
    'rejects a changed %s binding at commit',
    async (kind) => {
      const input = await completionInput();
      const state = input.resolution.state;
      const replacementId = randomUUID();
      await writeState(sessDir, {
        ...state,
        binding: {
          ...state.binding,
          ...(kind === 'session' ? { hostSessionId: 'foreign' } : {}),
          ...(kind === 'worktree' ? { worktree: '/foreign' } : {}),
          ...(kind === 'fingerprint' ? { fingerprint: '0'.repeat(24) } : {}),
        },
        ...(kind === 'flowguard-session'
          ? { flowguardSessionId: replacementId, id: replacementId }
          : {}),
      });
      await expect(commitMutationCompletion(input)).rejects.toHaveProperty('code');
      expect((await readState(sessDir))!.mutationEpisodes[0]!.status).toBe('dispatch_authorized');
    },
  );
  it('recovers a regular error with one audited write; event and query are idempotent', async () => {
    const before = await readState(sessDir);
    // Both reads must observe the unresolved dispatch before either can commit.
    // Promise.all alone does not guarantee that scheduling: one reconciliation
    // can finish before the other's authority lookup, legitimately avoiding I/O.
    let releaseReads: (() => void) | undefined;
    const bothReading = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let reads = 0;
    const host = runtime(
      vi.fn(async () => {
        reads += 1;
        if (reads === 2) releaseReads?.();
        await bothReading;
        return hostHistory();
      }),
    );
    await Promise.all([
      reconcileHostMutationEpisodes(host.value, sessionId),
      reconcileMutationEvent(host.value, {
        type: 'session.tool.failed',
        data: { sessionID: sessionId, id: 'edit-call' },
      }),
    ]);
    const state = await readState(sessDir);
    expect(state!.mutationEpisodes[0]).toMatchObject({
      status: 'completed',
      outcome: 'failure',
      completedAt,
      implementationDigest: null,
      evidenceStatus: 'ineligible',
    });
    expect(state!.pendingAuditOperations).toHaveLength(before!.pendingAuditOperations.length + 1);
    await reconcileHostMutationEpisodes(host.value, sessionId);
    expect(host.messages).toHaveBeenCalledTimes(2);
    expect(host.messages).toHaveBeenCalledWith(sessionId);
    expect(await readState(sessDir)).toEqual(state);
  });

  it('ignores raw event claims and re-reads interrupted host evidence', async () => {
    const host = runtime(vi.fn(async () => hostHistory(true)));
    await reconcileMutationEvent(host.value, {
      type: 'session.tool.failed',
      data: { sessionID: sessionId, id: 'edit-call' },
    });
    await reconcileHostMutationEpisodes(host.value, sessionId);
    expect((await readState(sessDir))!.mutationEpisodes[0]!.status).toBe('dispatch_authorized');
    expect(host.value.log.info).toHaveBeenCalledWith(
      'mutation',
      'host mutation remains unresolved',
      expect.objectContaining({ sessionId, hostCallId: 'edit-call', reason: expect.any(String) }),
    );
  });

  it.each(['throw', 'old-envelope', 'missing'])(
    'surfaces a host query failure (%s) without completing',
    async (mode) => {
      const host = runtime(
        vi.fn(async () => {
          if (mode === 'throw') throw new Error('wire failed');
          return mode === 'old-envelope' ? { data: hostHistory() } : undefined;
        }),
      );
      await expect(reconcileHostMutationEpisodes(host.value, sessionId)).rejects.toMatchObject({
        code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      });
      expect((await readState(sessDir))!.mutationEpisodes[0]!.status).toBe('dispatch_authorized');
    },
  );

  it('preserves a dispatch authorized during the host query', async () => {
    const host = runtime(
      vi.fn(async () => {
        const state = (await readState(sessDir))!;
        const authorized = authorizeMutationEpisode(state.mutationEpisodes, {
          episodeId: randomUUID(),
          hostCallId: 'other-call',
          toolName: 'edit',
          runtimeInstanceId: getRuntimeInstanceId(),
          leaseGeneration: 1,
          authorizedAt: at,
        });
        if (authorized.kind !== 'authorized') throw new Error('fixture');
        await writeState(sessDir, { ...state, mutationEpisodes: authorized.episodes });
        return hostHistory();
      }),
    );
    await reconcileHostMutationEpisodes(host.value, sessionId);
    expect((await readState(sessDir))!.mutationEpisodes.map((episode) => episode.status)).toEqual([
      'completed',
      'dispatch_authorized',
    ]);
  });

  it('rechecks lease authority after the host query (a live foreign holder cannot be fenced)', async () => {
    const input = await completionInput();
    const state = input.resolution.state;
    await writeState(sessDir, {
      ...state,
      runtimeLease: {
        ...state.runtimeLease!,
        holderRuntimeInstanceId: randomUUID(),
        generation: 2,
      },
    });
    await expect(commitMutationCompletion(input)).rejects.toMatchObject({
      code: 'MUTATION_EPISODE_LEASE_UNAVAILABLE',
    });
    expect((await readState(sessDir))!.mutationEpisodes[0]!.status).toBe('dispatch_authorized');
  });

  it('allows an observed historical outcome only after canonical dead-holder lease takeover', async () => {
    const input = await completionInput();
    const state = input.resolution.state;
    await writeState(sessDir, {
      ...state,
      runtimeLease: { ...state.runtimeLease!, holderPid: 999999 },
    });
    resetRuntimeInstanceIdForTest();
    await commitMutationCompletion(input);
    const after = (await readState(sessDir))!;
    expect(after.runtimeLease!.generation).toBe(2);
    expect(after.mutationEpisodes[0]!.outcome).toBe('failure');
    expect(after.mutationEpisodeResolutions).toEqual([]);
  });

  it('does not rewrite a resolution committed between observation and completion', async () => {
    const input = await completionInput();
    await writeState(sessDir, {
      ...input.resolution.state,
      mutationEpisodeResolutions: [
        {
          resolutionId: randomUUID(),
          hostCallId: 'edit-call',
          status: 'reconciled_after_unknown_outcome',
          basis: 'worktree_recapture',
          resolvedAt: completedAt,
          resolvingRuntimeInstanceId: randomUUID(),
          resolvingLeaseGeneration: 2,
        },
      ],
    });
    const before = await readState(sessDir);
    expect(await commitMutationCompletion(input)).toBe('unchanged');
    expect(await readState(sessDir)).toEqual(before);
  });

  it('does not reclassify any prior completed outcome, including unknown', async () => {
    const input = await completionInput();
    await writeState(sessDir, {
      ...input.resolution.state,
      mutationEpisodes: [
        { ...input.expected, status: 'completed', outcome: 'unknown', completedAt },
      ],
    });
    const before = await readState(sessDir);
    expect(await commitMutationCompletion(input)).toBe('unchanged');
    expect(await readState(sessDir)).toEqual(before);
  });

  it.each([
    'episodeId',
    'runtimeInstanceId',
    'authorizedAt',
    'toolName',
    'leaseGeneration',
  ] as const)('refuses changed dispatch identity: %s', async (key) => {
    const input = await completionInput();
    const patch = {
      episodeId: randomUUID(),
      runtimeInstanceId: randomUUID(),
      authorizedAt: completedAt,
      toolName: 'write',
      leaseGeneration: 2,
    };
    await writeState(sessDir, {
      ...input.resolution.state,
      runtimeLease: { ...input.resolution.state.runtimeLease!, generation: 3 },
      mutationEpisodes: [{ ...input.expected, [key]: patch[key] }],
    });
    await expect(commitMutationCompletion(input)).rejects.toMatchObject({
      code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
    });
  });

  it('surfaces persistence failure without acknowledging completion', async () => {
    const input = await completionInput();
    vi.spyOn(outbox, 'writeStateWithAuditOperationsAlreadyLocked').mockRejectedValueOnce(
      new PersistenceError('WRITE_FAILED', 'disk full'),
    );
    await expect(commitMutationCompletion(input)).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect((await readState(sessDir))!.mutationEpisodes[0]!.status).toBe('dispatch_authorized');
  });
});
