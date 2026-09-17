/**
 * @module integration/auto-validation-retry-authority.test
 * @description Regression coverage for durable system-work retry authority.
 *
 * Proves the retry contract added after PR #895 review:
 * - the initial automatic technical outcome is re-armed just like lifecycle recovery,
 * - a stale attempt cannot overwrite a newer pending-operation generation,
 * - retry-authority persistence failure is a typed BLOCKED outcome.
 *
 * @test-policy CORNER, BAD
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  withStrictReviewFindings,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { hydrate, ticket, plan, decision, status } from './tools/index.js';
import { rearmPendingSystemWork, resumePendingSystemWork } from './tools/auto-validation.js';
import { readState, writeState } from '../adapters/persistence.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { clearUserDecisionIntents, recordUserDecisionIntent } from './user-decision-intent.js';
import type { ToolDefinition } from './tools/helpers.js';
import type { SessionState } from '../state/schema.js';
import type { VerificationCandidateKind } from '../state/discovery-schemas.js';
import type { SystemWorkOperation } from '../state/system-work.js';

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    isGitRepo: vi.fn().mockResolvedValue(true),
    isGitRepoStrict: vi.fn().mockResolvedValue(true),
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
    headCommitFull: vi.fn().mockResolvedValue('d'.repeat(40)),
  };
});

vi.mock('../adapters/frozen-repository.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/frozen-repository.js')>();
  return {
    ...original,
    freezeRepositoryIdentity: vi.fn(() => ({
      kind: 'local' as const,
      rootCommitDigest: 'sha256:' + 'b'.repeat(64),
    })),
    freezeWorktreeCandidate: vi.fn().mockResolvedValue('c'.repeat(40)),
  };
});

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    }),
  };
});

vi.mock('../verification/executor', () => ({
  executeCheck: vi.fn().mockImplementation(async (input: { kind: string; command: string }) => ({
    kind: input.kind,
    command: input.command,
    exitCode: 0,
    passed: true,
    executionMs: 100,
    outputDigest: 'a'.repeat(64),
    stdout: 'OK',
    stderr: '',
    timedOut: false,
    startedAt: new Date().toISOString(),
  })),
}));

const executorMock = await import('../verification/executor.js');
const actorMock = await import('../adapters/actor.js');

let ws: TestWorkspace;
let ctx: TestToolContext;

beforeEach(async () => {
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
});

afterEach(async () => {
  clearUserDecisionIntents();
  vi.mocked(actorMock.resolveActor)
    .mockReset()
    .mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    });
  vi.clearAllMocks();
  await ws.cleanup();
});

async function getSessDir(): Promise<string> {
  const fp = await computeFingerprint(ctx.worktree);
  return resolveSessionDir(fp.fingerprint, ctx.sessionID);
}

async function getPhase(): Promise<string> {
  return (parseToolResult(await status.execute({}, ctx)).phase as string) ?? '';
}

function recordDecisionIntentForTool(tool: ToolDefinition, args: unknown): void {
  if (tool !== decision || typeof args !== 'object' || args === null) return;
  const verdict = (args as { verdict?: unknown }).verdict;
  if (verdict !== 'approve' && verdict !== 'changes_requested' && verdict !== 'reject') return;
  recordUserDecisionIntent({
    sessionId: ctx.sessionID,
    command: '/review-decision',
    expectedVerdict: verdict,
  });
}

async function callOk(tool: ToolDefinition, args: unknown): Promise<Record<string, unknown>> {
  const finalArgs = await withStrictReviewFindings(await getSessDir(), args);
  recordDecisionIntentForTool(tool, finalArgs);
  const result = parseToolResult(await tool.execute(finalArgs, ctx));
  if (result.error) {
    throw new Error(`Tool returned error: ${result.code} — ${result.message}`);
  }
  return result;
}

async function reachTeamPlanReview(): Promise<void> {
  await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' });
  await callOk(ticket, { text: 'Retry authority task', source: 'user' });
  await callOk(plan, {
    planText: '## Plan\n1. Apply the fix',
    targetPaths: ['docs/test.md'],
  });
  for (let i = 0; i < 5 && (await getPhase()) !== 'PLAN_REVIEW'; i++) {
    await callOk(plan, { reviewVerdict: 'accept' });
  }
  expect(await getPhase()).toBe('PLAN_REVIEW');
}

function timedOutCheck(kind: VerificationCandidateKind, command: string) {
  return {
    kind,
    command,
    exitCode: 124,
    passed: false,
    executionMs: 60_000,
    outputDigest: '0'.repeat(64),
    stdout: '',
    stderr: '',
    timedOut: true,
    startedAt: new Date().toISOString(),
  };
}

async function forceValidationWithMarker(marker: SystemWorkOperation): Promise<void> {
  const sessDir = await getSessDir();
  const state = await readState(sessDir);
  await writeState(sessDir, {
    ...state!,
    phase: 'VALIDATION',
    pendingSystemWork: marker,
    validation: [],
  });
}

describe('system-work retry authority', () => {
  it('re-arms the initial automatic technical outcome before returning', async () => {
    await reachTeamPlanReview();
    vi.mocked(executorMock.executeCheck).mockImplementationOnce(async (input) =>
      timedOutCheck(input.kind as VerificationCandidateKind, input.command),
    );

    const result = await callOk(decision, {
      verdict: 'approve',
      rationale: 'Approved',
    });

    expect(result.phase).toBe('VALIDATION');
    const state = await readState(await getSessDir());
    expect(state!.pendingSystemWork).toMatchObject({
      kind: 'validation',
      attempt: 1,
    });
    expect(state!.pendingSystemWork!.retryAfter).not.toBeNull();
  });

  it('does not let a stale attempt overwrite a newer operation generation', async () => {
    await reachTeamPlanReview();
    const expected: SystemWorkOperation = {
      kind: 'validation',
      requestedAt: '2026-09-16T09:00:00.000Z',
      attempt: 0,
      retryAfter: null,
    };
    const newer: SystemWorkOperation = {
      kind: 'validation',
      requestedAt: '2026-09-16T09:00:01.000Z',
      attempt: 0,
      retryAfter: null,
    };
    await forceValidationWithMarker(newer);

    const persistState = vi.fn(async (_sessDir: string, next: SessionState) => next);
    const result = await rearmPendingSystemWork(ctx, expected, {
      persistState,
      nowMs: () => Date.parse('2026-09-16T09:00:02.000Z'),
    });

    expect(result).toEqual({ kind: 'superseded' });
    expect(persistState).not.toHaveBeenCalled();
    expect((await readState(await getSessDir()))!.pendingSystemWork).toEqual(newer);
  });

  it('returns BLOCKED when retry authority cannot be persisted', async () => {
    await reachTeamPlanReview();
    const marker: SystemWorkOperation = {
      kind: 'validation',
      requestedAt: '2026-09-16T09:00:00.000Z',
      attempt: 0,
      retryAfter: null,
    };
    await forceValidationWithMarker(marker);
    vi.mocked(executorMock.executeCheck).mockImplementationOnce(async (input) =>
      timedOutCheck(input.kind as VerificationCandidateKind, input.command),
    );

    const persistState = vi.fn(async () => {
      throw new Error('simulated disk failure');
    });
    const result = await resumePendingSystemWork(ctx, {
      persistState,
      nowMs: () => Date.parse('2026-09-16T09:00:02.000Z'),
    });

    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') throw new Error('expected blocked outcome');
    expect(result.code).toBe('WRITE_FAILED');
    expect(parseToolResult(result.response)).toMatchObject({
      error: true,
      code: 'WRITE_FAILED',
    });
    expect(persistState).toHaveBeenCalledTimes(1);

    const finalState = await readState(await getSessDir());
    expect(finalState!.phase).toBe('VALIDATION');
    expect(finalState!.pendingSystemWork).toEqual(marker);
  });
});
