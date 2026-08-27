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

import { describe, expect, it } from 'vitest';
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
import { implement, review_implementation, reconcile_mutation_episode } from './tools/index.js';
import { hasUnresolvedMutationEpisodes } from '../state/evidence-mutation-episode.js';

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

  it('keeps a crashed dispatch fail-closed and recovers via append-only resolution', async () => {
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
      await ws.cleanup();
    }
  });

  it('requires fresh implementation evidence after an unknown-outcome resolution', async () => {
    const ws = await createTestWorkspace();
    try {
      const sessionID = crypto.randomUUID();
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, sessionID);
      await fs.mkdir(sessDir, { recursive: true });
      await writeStateWithArtifacts(sessDir, makeProgressedState('IMPL_REVIEW'));

      const hooks = await FlowGuardAuditPlugin(
        createMockInput({ worktree: ws.tmpDir, directory: ws.tmpDir }),
      );
      const beforeHook = hooks['tool.execute.before']!;

      const crashedCallID = crypto.randomUUID();
      await beforeHook(
        { tool: 'edit', sessionID, callID: crashedCallID },
        { args: { filePath: 'x.ts', old: 'a', new: 'b' } },
      );

      const ctx = createToolContext({ sessionID, worktree: ws.tmpDir, directory: ws.tmpDir });
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
      await ws.cleanup();
    }
  });
});
