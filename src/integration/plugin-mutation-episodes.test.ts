/**
 * @module integration/plugin-mutation-episodes.test
 * @description Contract tests for the After-hook mutation completion boundary:
 *              fail-closed completion guards, delayed-After handling after
 *              fenced recovery, and the best-effort outcome classification.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordMutationCompletion } from './plugin-mutation-episodes.js';
import { readState } from '../adapters/persistence.js';
import { makeProgressedState } from '../fixtures.js';
import { resolveWorkspacePaths, writeStateWithArtifacts } from './tools/helpers.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-mutation-completion-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

interface SeedEpisode {
  readonly hostCallId: string;
  readonly toolName: string;
  readonly leaseGeneration?: number;
}

async function seedSession(
  options: {
    readonly episodes?: readonly SeedEpisode[];
    readonly resolutions?: readonly string[];
  } = {},
): Promise<{ sessionId: string; sessDir: string; runtime: never }> {
  const sessionId = crypto.randomUUID();
  const context = { sessionID: sessionId, worktree: tmpDir, directory: tmpDir };
  const { sessDir } = await resolveWorkspacePaths(context);
  const base = makeProgressedState('IMPLEMENTATION');
  await writeStateWithArtifacts(sessDir, {
    ...base,
    mutationEpisodes: (options.episodes ?? []).map((episode) => ({
      episodeId: crypto.randomUUID(),
      hostCallId: episode.hostCallId,
      toolName: episode.toolName,
      runtimeInstanceId: crypto.randomUUID(),
      leaseGeneration: episode.leaseGeneration ?? 1,
      authorizedAt: '2026-01-01T00:00:00.000Z',
      status: 'dispatch_authorized' as const,
      completedAt: null,
      outcome: null,
      implementationDigest: null,
      evidenceStatus: 'ineligible' as const,
    })),
    mutationEpisodeResolutions: (options.resolutions ?? []).map((hostCallId) => ({
      resolutionId: crypto.randomUUID(),
      hostCallId,
      status: 'reconciled_after_unknown_outcome' as const,
      basis: 'worktree_recapture' as const,
      resolvedAt: '2026-01-15T00:00:00.000Z',
      resolvingRuntimeInstanceId: crypto.randomUUID(),
      resolvingLeaseGeneration: 2,
    })),
  });
  const runtime = { ws: { getSessionDir: () => sessDir } } as never;
  return { sessionId, sessDir, runtime };
}

function hookOutput(
  metadata: Record<string, unknown> = {},
  output = '',
): { metadata: Record<string, unknown>; output: string } {
  return { metadata, output };
}

async function runCompletion(
  runtime: never,
  sessionId: string,
  tool: string,
  callID: string | undefined,
  metadata: Record<string, unknown> = {},
  output = '',
): Promise<{ metadata: Record<string, unknown>; output: string }> {
  const hookInput = { tool, callID } as never;
  const result = hookOutput(metadata, output);
  await recordMutationCompletion({
    runtime,
    sessionId,
    hookInput,
    hookOutput: result as never,
    now: '2026-02-01T00:00:00.000Z',
  });
  return result;
}

function blockedCode(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as { code?: string };
    return parsed.code;
  } catch {
    return undefined;
  }
}

describe('recordMutationCompletion fail-closed guards', () => {
  it('ignores non-mutating host tools', async () => {
    const { sessionId, runtime } = await seedSession();

    const output = await runCompletion(runtime, sessionId, 'read', 'call-1');

    expect(output.output).toBe('');
  });

  it('blocks a completed mutating call without a callID', async () => {
    const { sessionId, runtime } = await seedSession();

    const output = await runCompletion(runtime, sessionId, 'bash', undefined);

    expect(blockedCode(output.output)).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
    expect(output.output).toContain('no host callID');
  });

  it('blocks when the session directory cannot be resolved', async () => {
    const { sessionId } = await seedSession();
    const runtime = { ws: { getSessionDir: () => null } } as never;

    const output = await runCompletion(runtime, sessionId, 'bash', 'call-1');

    expect(blockedCode(output.output)).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
    expect(output.output).toContain('no resolvable FlowGuard session directory');
  });

  it('blocks when session state disappeared', async () => {
    const { sessionId, runtime } = await seedSession();
    const { sessDir } = await resolveWorkspacePaths({
      sessionID: sessionId,
      worktree: tmpDir,
      directory: tmpDir,
    });
    await fs.rm(sessDir, { recursive: true, force: true });

    const output = await runCompletion(runtime, sessionId, 'bash', 'call-1');

    expect(blockedCode(output.output)).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
    expect(output.output).toContain('state disappeared');
  });

  it('blocks when no authorized episode exists for the call and tool', async () => {
    const { sessionId, runtime } = await seedSession({
      episodes: [{ hostCallId: 'call-1', toolName: 'edit' }],
    });

    const wrongTool = await runCompletion(runtime, sessionId, 'bash', 'call-1');
    expect(blockedCode(wrongTool.output)).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
    expect(wrongTool.output).toContain('No authorized mutation episode');

    const missing = await runCompletion(runtime, sessionId, 'bash', 'call-other');
    expect(blockedCode(missing.output)).toBe('PLUGIN_ENFORCEMENT_UNAVAILABLE');
  });

  it('ignores a delayed After hook after the episode was already resolved', async () => {
    const { sessionId, sessDir, runtime } = await seedSession({
      episodes: [{ hostCallId: 'call-resolved', toolName: 'bash' }],
      resolutions: ['call-resolved'],
    });

    const output = await runCompletion(runtime, sessionId, 'bash', 'call-resolved');

    expect(output.output).toBe('');
    const state = await readState(sessDir);
    expect(state!.mutationEpisodes[0]!.status).toBe('dispatch_authorized');
    expect(state!.mutationEpisodes[0]!.outcome).toBeNull();
    expect(state!.mutationEpisodeResolutions).toHaveLength(1);
  });
});

describe('mutation outcome classification', () => {
  async function completedOutcome(
    tool: string,
    metadata: Record<string, unknown>,
    output = '',
  ): Promise<string | null> {
    const { sessionId, sessDir, runtime } = await seedSession({
      episodes: [{ hostCallId: 'call-x', toolName: tool }],
    });
    await runCompletion(runtime, sessionId, tool, 'call-x', metadata, output);
    const state = await readState(sessDir);
    return state!.mutationEpisodes[0]!.outcome;
  }

  it('treats an explicit metadata error as failure with precedence over success', async () => {
    expect(await completedOutcome('bash', { error: true, success: true, exit: 0 })).toBe('failure');
  });

  it('classifies a bash exit code', async () => {
    expect(await completedOutcome('bash', { exit: 0 })).toBe('success');
    expect(await completedOutcome('bash', { exit: 1 })).toBe('failure');
    expect(await completedOutcome('bash', { exit: 'zero' })).toBe('unknown');
  });

  it('classifies structured output signals', async () => {
    expect(await completedOutcome('bash', {}, JSON.stringify({ error: true }))).toBe('failure');
    expect(await completedOutcome('bash', {}, JSON.stringify({ success: true }))).toBe('success');
    expect(await completedOutcome('bash', {}, 'unparsable-output')).toBe('unknown');
  });

  it('classifies apply_patch by its files array', async () => {
    expect(await completedOutcome('apply_patch', { files: ['src/a.ts'] })).toBe('success');
    expect(await completedOutcome('apply_patch', { files: 'src/a.ts' })).toBe('unknown');
  });

  it('classifies write by its complete success contract', async () => {
    const complete = {
      filepath: 'src/a.ts',
      exists: false,
      diagnostics: { errors: [] },
    };
    expect(await completedOutcome('write', complete)).toBe('success');
    expect(await completedOutcome('write', { ...complete, filepath: 42 })).toBe('unknown');
    expect(await completedOutcome('write', { ...complete, exists: 'no' })).toBe('unknown');
    expect(await completedOutcome('write', { ...complete, diagnostics: [] })).toBe('unknown');
  });

  it('classifies edit by its complete success contract', async () => {
    const complete = {
      diff: '--- a\n+++ b\n',
      filediff: { file: 'src/a.ts', patch: 'x', additions: 1, deletions: 0 },
      diagnostics: { errors: [] },
    };
    expect(await completedOutcome('edit', complete)).toBe('success');
    expect(await completedOutcome('edit', { ...complete, diff: undefined })).toBe('unknown');
    expect(
      await completedOutcome('edit', {
        ...complete,
        filediff: { file: 'src/a.ts', patch: 'x', additions: 1 },
      }),
    ).toBe('unknown');
    expect(await completedOutcome('edit', { ...complete, filediff: 'x' })).toBe('unknown');
  });
});
