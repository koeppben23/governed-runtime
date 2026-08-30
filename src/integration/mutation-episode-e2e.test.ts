/**
 * @module integration/mutation-episode-e2e
 * @description End-to-end host mutation provenance through the REAL plugin
 *              runtime: durable Before-hook dispatch authorization, an actual
 *              worktree mutation between the hooks, After-hook completion
 *              binding, replay protection, crash recovery, and the
 *              unknown-outcome revalidation contract.
 *
 * This is the exact-head CI gate for the Assurance host contract:
 *
 *   real plugin tool.execute.before(callID)
 *   -> durable MutationEpisode (dispatch_authorized)
 *   -> actual host mutation (write/edit/apply_patch/bash)
 *   -> tool.execute.after(same callID)
 *   -> /implement binding / crash recovery
 *
 * No part of the plugin, persistence, or hook pipeline is mocked.
 */

import { describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FlowGuardAuditPlugin } from './plugin.js';
import { createTestWorkspace, createToolContext, parseToolResult } from './test-helpers.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { readState, writeState } from '../adapters/persistence.js';
import { writeStateWithArtifacts } from './tools/helpers.js';
import { FROZEN_IMPLEMENTATION_BASE, IMPL_EVIDENCE, makeProgressedState } from '../fixtures.js';
import {
  decision,
  implement,
  review_implementation,
  reconcile_mutation_episode,
} from './tools/index.js';
import { hasUnresolvedMutationEpisodes } from '../state/evidence-mutation-episode.js';
import { resetRuntimeInstanceIdForTest } from './runtime-instance.js';
import { RUNTIME_LEASE_FILE } from './runtime-lease.js';
import { recordUserDecisionIntent } from './user-decision-intent.js';

// The plugin/persistence/hook pipeline itself is unmocked; only the git
// ADAPTER (external system boundary) is mocked: the test workspace carries a
// fake `.git` marker rather than a real repository. The git prerequisite gate
// is exercised for real in the dedicated non-Git regression below, which
// overrides this default with mockResolvedValueOnce(false).
vi.mock('../adapters/git.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    isGitRepoStrict: vi.fn().mockResolvedValue(true),
  };
});

/** Simulate the death of the lease holder (a real dead process fails PID liveness). */
async function killLeaseHolder(sessDir: string): Promise<void> {
  const lease = JSON.parse(
    await fs.readFile(path.join(sessDir, RUNTIME_LEASE_FILE), 'utf-8'),
  ) as Record<string, unknown>;
  lease.holderPid = 999999;
  await fs.writeFile(path.join(sessDir, RUNTIME_LEASE_FILE), JSON.stringify(lease), 'utf-8');
}

function createMockInput(overrides: Record<string, unknown> = {}) {
  return {
    project: {} as unknown,
    client: {
      app: {
        log: async () => {},
      },
    } as unknown,
    $: {} as unknown,
    directory: '/tmp/mock-dir',
    worktree: '/tmp/mock-worktree',
    serverUrl: new URL('http://localhost:3000'),
    ...overrides,
  } as Parameters<typeof FlowGuardAuditPlugin>[0];
}

describe('mutation episode end-to-end (real plugin runtime)', () => {
  it('authorizes durably, binds the completed host mutation, and blocks replay', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessionID = crypto.randomUUID();
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
      await fs.mkdir(sessDir, { recursive: true });
      await writeStateWithArtifacts(sessDir, makeProgressedState('IMPLEMENTATION'));

      const hooks = await FlowGuardAuditPlugin(
        createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
      );
      const beforeHook = hooks['tool.execute.before']!;
      const afterHook = hooks['tool.execute.after']!;

      const callID = crypto.randomUUID();
      await expect(
        beforeHook(
          { tool: 'bash', sessionID, callID },
          { args: { command: 'echo host-mutation' } },
        ),
      ).resolves.toBeUndefined();

      // The dispatch authorization is DURABLE before the host may execute.
      const authorized = await readState(sessDir);
      expect(
        authorized!.mutationEpisodes.find((episode) => episode.hostCallId === callID),
      ).toMatchObject({
        hostCallId: callID,
        toolName: 'bash',
        status: 'dispatch_authorized',
        evidenceStatus: 'ineligible',
      });

      // Replaying the same hostCallId is never idempotent success — blocked.
      await expect(
        beforeHook({ tool: 'bash', sessionID, callID }, { args: { command: 'echo replay' } }),
      ).rejects.toThrow('MUTATION_EPISODE_REPLAY_BLOCKED');
      const afterReplay = await readState(sessDir);
      expect(afterReplay!.mutationEpisodes).toHaveLength(1);

      // The host performs its actual mutation between the hooks.
      await fs.writeFile(path.join(ws.tmpDir, 'host-mutation.txt'), 'changed by host', 'utf-8');

      // The After-hook completes the episode with the observed outcome.
      await afterHook(
        { tool: 'bash', sessionID, callID, args: { command: 'echo host-mutation' } },
        { title: 'bash', output: '{}', metadata: { success: true } },
      );
      const completed = await readState(sessDir);
      expect(
        completed!.mutationEpisodes.find((episode) => episode.hostCallId === callID),
      ).toMatchObject({
        status: 'completed',
        outcome: 'success',
      });
    } finally {
      await ws.cleanup();
    }
  });

  it('blocks the first mutating host operation in a non-Git worktree (NOT_GIT_REPO) without authorizing a dispatch', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessionID = crypto.randomUUID();
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
      await fs.mkdir(sessDir, { recursive: true });
      await writeStateWithArtifacts(sessDir, makeProgressedState('IMPLEMENTATION'));

      const hooks = await FlowGuardAuditPlugin(
        createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
      );
      const beforeHook = hooks['tool.execute.before']!;

      // Non-Git worktree: the git prerequisite gate must fail closed BEFORE the
      // dispatch is authorized — no MutationEpisode, no repository mutation.
      const gitAdapter = await import('../adapters/git.js');
      vi.mocked(gitAdapter.isGitRepoStrict).mockResolvedValueOnce(false);

      const callID = crypto.randomUUID();
      await expect(
        beforeHook(
          { tool: 'bash', sessionID, callID },
          { args: { command: 'echo blocked-mutation' } },
        ),
      ).rejects.toThrow('NOT_GIT_REPO');

      const persisted = await readState(sessDir);
      expect(persisted!.mutationEpisodes).toHaveLength(0);
    } finally {
      await ws.cleanup();
    }
  });

  it.each(['EVIDENCE_REVIEW', 'COMPLETE'] as const)(
    'blocks apply_patch before dispatch in %s without recording a mutation episode',
    async (phase) => {
      const ws = await createTestWorkspace();
      try {
        const sessionID = crypto.randomUUID();
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
        await fs.mkdir(sessDir, { recursive: true });
        const implementationState = makeProgressedState('IMPLEMENTATION');
        await writeStateWithArtifacts(sessDir, { ...implementationState, phase });

        const hooks = await FlowGuardAuditPlugin(
          createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
        );
        const beforeHook = hooks['tool.execute.before']!;

        await expect(
          beforeHook(
            { tool: 'apply_patch', sessionID, callID: crypto.randomUUID() },
            { args: { patch: '*** Begin Patch\n*** End Patch' } },
          ),
        ).rejects.toThrow('HOST_TOOL_PHASE_DENIED');

        const persisted = await readState(sessDir);
        expect(persisted!.mutationEpisodes).toHaveLength(0);
      } finally {
        await ws.cleanup();
      }
    },
  );

  it('keeps a crashed dispatch fail-closed and recovers only after a fenced runtime restart', async () => {
    const ws = await createTestWorkspace();
    try {
      // Fresh runtime identity for this test (simulates a fresh process).
      resetRuntimeInstanceIdForTest();
      const sessionID = crypto.randomUUID();
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
      await fs.mkdir(sessDir, { recursive: true });
      await writeStateWithArtifacts(sessDir, makeProgressedState('IMPLEMENTATION'));

      const hooks = await FlowGuardAuditPlugin(
        createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
      );
      const beforeHook = hooks['tool.execute.before']!;

      const crashedCallID = crypto.randomUUID();
      await beforeHook(
        { tool: 'apply_patch', sessionID, callID: crashedCallID },
        { args: { patch: 'x' } },
      );
      // Simulate the crash: no After-hook ever runs.

      const ctx = createToolContext({ sessionID, worktree: ws.tmpDir, directory: ws.tmpDir });

      const blockedResult = parseToolResult<{ code?: string }>(
        await implement.execute({}, ctx as never),
      );
      expect(blockedResult.code).toBe('MUTATION_EPISODE_UNRESOLVED');

      // Recovery Authority boundary: the CURRENT runtime holds the SAME lease
      // generation that authorized the dispatch — the authorizing epoch is
      // not provably over.
      const sameEpochResolution = parseToolResult<{ code?: string }>(
        await reconcile_mutation_episode.execute({ hostCallId: crashedCallID }, ctx as never),
      );
      expect(sameEpochResolution.code).toBe('MUTATION_EPISODE_RUNTIME_EPOCH_ACTIVE');
      const afterEpochBlock = await readState(sessDir);
      expect(afterEpochBlock!.mutationEpisodeResolutions).toHaveLength(0);

      // A CONCURRENT instance cannot acquire the live lease at all — even a
      // different process identity proves nothing about the authorizing epoch.
      resetRuntimeInstanceIdForTest();
      const concurrentInstance = parseToolResult<{ code?: string }>(
        await reconcile_mutation_episode.execute({ hostCallId: crashedCallID }, ctx as never),
      );
      expect(concurrentInstance.code).toBe('MUTATION_EPISODE_LEASE_UNAVAILABLE');
      const afterConcurrentBlock = await readState(sessDir);
      expect(afterConcurrentBlock!.mutationEpisodeResolutions).toHaveLength(0);

      // Restart with fencing: the holder DIES, and the new instance acquires a
      // LATER lease generation — the provable end of the authorizing epoch.
      await killLeaseHolder(sessDir);
      const resolvedResult = parseToolResult<{ code?: string }>(
        await reconcile_mutation_episode.execute({ hostCallId: crashedCallID }, ctx as never),
      );
      expect(resolvedResult.code).toBe('MUTATION_EPISODE_RESOLVED');

      const resolved = await readState(sessDir);
      expect(resolved!.mutationEpisodeResolutions).toHaveLength(1);
      expect(resolved!.mutationEpisodeResolutions[0]).toMatchObject({
        hostCallId: crashedCallID,
        status: 'reconciled_after_unknown_outcome',
        basis: 'worktree_recapture',
      });
      // The episode itself stays dispatch_authorized forever — only the
      // resolution makes it non-blocking.
      expect(
        resolved!.mutationEpisodes.find((episode) => episode.hostCallId === crashedCallID)?.status,
      ).toBe('dispatch_authorized');
      expect(
        hasUnresolvedMutationEpisodes(
          resolved!.mutationEpisodes,
          resolved!.mutationEpisodeResolutions,
        ),
      ).toBe(false);

      // /implement is no longer blocked by the unresolved episode.
      const afterRecovery = parseToolResult<{ code?: string }>(
        await implement.execute({}, ctx as never),
      );
      expect(afterRecovery.code).not.toBe('MUTATION_EPISODE_UNRESOLVED');

      // A double resolution is a no-op, never a rewrite (append-only).
      const doubleResult = parseToolResult<{ code?: string }>(
        await reconcile_mutation_episode.execute({ hostCallId: crashedCallID }, ctx as never),
      );
      expect(doubleResult.code).toBe('MUTATION_EPISODE_ALREADY_RESOLVED');
      const afterDouble = await readState(sessDir);
      expect(afterDouble!.mutationEpisodeResolutions).toHaveLength(1);
    } finally {
      resetRuntimeInstanceIdForTest();
      await ws.cleanup();
    }
  });

  it('requires fresh implementation evidence after an unknown-outcome resolution', async () => {
    const ws = await createTestWorkspace();
    try {
      resetRuntimeInstanceIdForTest();
      const sessionID = crypto.randomUUID();
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
      await fs.mkdir(sessDir, { recursive: true });
      const reviewState = makeProgressedState('IMPL_REVIEW');
      await writeStateWithArtifacts(sessDir, { ...reviewState, phase: 'IMPLEMENTATION' });

      const hooks = await FlowGuardAuditPlugin(
        createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
      );
      const beforeHook = hooks['tool.execute.before']!;

      const crashedCallID = crypto.randomUUID();
      await beforeHook(
        { tool: 'edit', sessionID, callID: crashedCallID },
        { args: { filePath: 'x.ts', old: 'a', new: 'b' } },
      );

      // Model a host crash after dispatch while the workflow has moved to the
      // review stage. The recovery gate must still reject the stale evidence.
      const dispatched = await readState(sessDir);
      await writeState(sessDir, { ...dispatched!, phase: 'IMPL_REVIEW' });

      const ctx = createToolContext({ sessionID, worktree: ws.tmpDir, directory: ws.tmpDir });

      // Simulate the fenced restart: the previous holder DIES, and the new
      // runtime instance acquires a later lease generation.
      await killLeaseHolder(sessDir);
      resetRuntimeInstanceIdForTest();
      await reconcile_mutation_episode.execute({ hostCallId: crashedCallID }, ctx as never);

      // IMPL_EVIDENCE was recorded at the fixed 2026-01-01 fixture time —
      // before the resolution — so the review verdict must be rejected.
      const verdictResult = parseToolResult<{ code?: string }>(
        await review_implementation.execute({ reviewVerdict: 'accept' }, ctx as never),
      );
      expect(verdictResult.code).toBe('MUTATION_OUTCOME_UNKNOWN_REVALIDATION_REQUIRED');

      // Implementation evidence recorded AFTER the resolution passes the gate.
      const revalidatedState = await readState(sessDir);
      const freshEvidence = {
        ...IMPL_EVIDENCE,
        digest: 'digest-of-fresh-recapture',
        executedAt: new Date().toISOString(),
      };
      await writeState(sessDir, {
        ...revalidatedState!,
        implementation: freshEvidence,
      });
      const freshVerdict = parseToolResult<{ code?: string }>(
        await review_implementation.execute({ reviewVerdict: 'accept' }, ctx as never),
      );
      expect(freshVerdict.code).not.toBe('MUTATION_OUTCOME_UNKNOWN_REVALIDATION_REQUIRED');
    } finally {
      resetRuntimeInstanceIdForTest();
      await ws.cleanup();
    }
  });

  it('allows a fenced recovered session with fresh evidence to complete', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessionID = crypto.randomUUID();
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
      await fs.mkdir(sessDir, { recursive: true });
      const recoveredState = makeProgressedState('EVIDENCE_REVIEW');
      await writeStateWithArtifacts(sessDir, {
        ...recoveredState,
        implementation: {
          ...recoveredState.implementation!,
          executedAt: '2026-02-01T00:00:00.000Z',
        },
        mutationEpisodes: [
          {
            episodeId: crypto.randomUUID(),
            hostCallId: 'crashed-host-edit',
            toolName: 'edit',
            runtimeInstanceId: crypto.randomUUID(),
            leaseGeneration: 1,
            authorizedAt: '2026-01-01T00:00:00.000Z',
            status: 'dispatch_authorized',
            completedAt: null,
            outcome: null,
            implementationDigest: null,
            evidenceStatus: 'ineligible',
          },
        ],
        mutationEpisodeResolutions: [
          {
            resolutionId: crypto.randomUUID(),
            hostCallId: 'crashed-host-edit',
            status: 'reconciled_after_unknown_outcome',
            basis: 'worktree_recapture',
            resolvedAt: '2026-01-15T00:00:00.000Z',
          },
        ],
      });
      const ctx = createToolContext({ sessionID, worktree: ws.tmpDir, directory: ws.tmpDir });
      recordUserDecisionIntent({
        sessionId: sessionID,
        command: '/approve',
        expectedVerdict: 'approve',
      });

      const approval = parseToolResult<{ code?: string }>(
        await decision.execute(
          { verdict: 'approve', rationale: 'fresh recovery evidence' },
          ctx as never,
        ),
      );

      expect(approval.code).not.toBe('MUTATION_EPISODE_BINDING_REQUIRED');
      expect((await readState(sessDir))!.phase).toBe('COMPLETE');
    } finally {
      await ws.cleanup();
    }
  });
});
