/**
 * @module integration/tools/review-tool/exact-id-repair.test
 * @description Regression: an explicit reviewObligationId DOMINATES content
 *              fingerprint matching.
 *
 * The canonical /review retry instruction is a review call carrying the
 * original content plus reviewObligationId and deliberately no findings.
 * The agent may legitimately omit inputOrigin/references metadata, which
 * changes the content fingerprint. Before this fix, that drift created a
 * SECOND obligation for the same review, splitting the reviewer lineage. Now:
 * exact ID or fail-closed. There is deliberately no repair reissue: an
 * explicit ID reuses the existing bindable attempt or fails closed.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import * as crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestWorkspace,
  createToolContext,
  parseToolResult,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
  withTestEnv,
} from '../../test-helpers.js';
import { review } from '../index.js';
import { hydrate } from '../index.js';
import { readState, writeState } from '../../../adapters/persistence.js';
import { appendReviewDispatch } from '../../../state/review-dispatch.js';

vi.mock('../../../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

vi.mock('../../../adapters/gh-cli', () => ({
  loadResolvedPullRequestDiff: vi.fn().mockReturnValue(''),
  resolvePullRequestReviewSource: vi.fn(),
  loadResolvedBranchDiff: vi.fn().mockReturnValue('diff --git a/docs/a.md b/docs/a.md\n+line\n'),
  resolveBranchReviewSource: vi.fn().mockImplementation((branch: string) => ({
    branch,
    baseBranch: 'main',
    resolvedBranchSha: 'a'.repeat(40),
    resolvedBaseSha: 'b'.repeat(40),
    repository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
  })),
  loadBranchChangedFiles: vi.fn().mockReturnValue(['docs/a.md']),
  loadPrChangedFiles: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../adapters/actor.js')>();
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env',
      assurance: 'best_effort',
    }),
  };
});

let ws: TestWorkspace;
let ctx: TestToolContext;
let cleanupEnv: () => void;

beforeEach(async () => {
  cleanupEnv = withTestEnv({ FLOWGUARD_POLICY_PATH: undefined });
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
});

afterEach(async () => {
  cleanupEnv();
  vi.clearAllMocks();
  await ws.cleanup();
});

async function hydrateTeam(): Promise<Record<string, unknown>> {
  return parseToolResult(await hydrate.execute({ policyMode: 'team', profileId: 'baseline' }, ctx));
}

async function currentSessionDir(): Promise<string> {
  const { computeFingerprint, sessionDir: resolveSessionDir } =
    await import('../../../adapters/workspace/index.js');
  const fp = await computeFingerprint(ws.tmpDir);
  return resolveSessionDir(fp.fingerprint, ctx.sessionID);
}

function requiredString(value: unknown, key: string): string {
  const record = value as Record<string, unknown>;
  const field = record[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`required string field missing: ${key}`);
  }
  return field;
}

describe('exact obligation identity dominates fingerprint matching', () => {
  it('HAPPY: a repeat call with an explicit ID reuses the same obligation and attempt', async () => {
    await hydrateTeam();
    const contentArgs = {
      branch: 'feature/add-due-date',
      inputOrigin: 'branch' as const,
      references: [{ ref: 'feature/add-due-date', type: 'branch' as const, source: 'local' }],
    };
    const first = parseToolResult(await review.execute(contentArgs, ctx));
    expect(first.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');

    const sessDir = await currentSessionDir();
    const afterFirst = await readState(sessDir);
    const firstAttempt = afterFirst!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId,
    );
    expect(firstAttempt?.ordinal).toBe(1);

    // The documented retry shape: original content field + reviewObligationId,
    // WITHOUT the inputOrigin/references metadata of the first call. It must
    // reuse the exact obligation and its bindable attempt — never mint a
    // second obligation or a repair attempt.
    const repeat = parseToolResult(
      await review.execute(
        { branch: 'feature/add-due-date', reviewObligationId: obligationId },
        ctx,
      ),
    );
    expect(repeat.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    expect(repeat.reviewDispatch).toEqual({ required: true });

    const afterRepeat = await readState(sessDir);
    expect(afterRepeat!.reviewAssurance!.obligations).toHaveLength(1);
    expect(afterRepeat!.reviewAssurance!.obligations[0]!.obligationId).toBe(obligationId);
    const attempts = afterRepeat!.reviewAssurance!.attempts.filter(
      (a) => a.obligationId === obligationId,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.attemptId).toBe(firstAttempt!.attemptId);
    expect(attempts[0]!.status).toBe('created');
  });

  it('BAD: unknown explicit ID fails closed — no fingerprint fallback, no creation', async () => {
    await hydrateTeam();
    const contentArgs = {
      branch: 'feature/add-due-date',
      inputOrigin: 'branch' as const,
      references: [{ ref: 'feature/add-due-date', type: 'branch' as const, source: 'local' }],
    };
    const first = parseToolResult(await review.execute(contentArgs, ctx));
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');

    const before = await readState(await currentSessionDir());
    const result = parseToolResult(
      await review.execute(
        {
          branch: 'feature/add-due-date',
          reviewObligationId: '00000000-0000-4000-8000-00000000dead',
        },
        ctx,
      ),
    );
    expect(result.code).toBe('REVIEW_OBLIGATION_NOT_FOUND');
    const after = await readState(await currentSessionDir());
    expect(after!.reviewAssurance!.obligations).toHaveLength(
      before!.reviewAssurance!.obligations.length,
    );
    expect(after!.reviewAssurance!.obligations.every((o) => o.obligationId === obligationId)).toBe(
      true,
    );
  });

  it('RECOVERY: re-arms an outcome-unknown peer dispatch on the same frozen obligation', async () => {
    await hydrateTeam();
    const contentArgs = { branch: 'feature/add-due-date', inputOrigin: 'branch' as const };
    const first = parseToolResult(await review.execute(contentArgs, ctx));
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    const firstAttemptId = first.reviewAttemptId as string;
    const sessDir = await currentSessionDir();
    const state = await readState(sessDir);
    expect(state?.reviewAssurance).toBeDefined();
    if (!state?.reviewAssurance) return;
    await writeState(sessDir, {
      ...state,
      reviewAssurance: appendReviewDispatch(state.reviewAssurance, {
        dispatchId: '00000000-0000-4000-8000-0000000000c1',
        attemptId: firstAttemptId,
        obligationId,
        hostCallId: 'peer-review-task-call',
        canonicalPromptDigest: 'd'.repeat(64),
        dispatchAuthorizedAt: '2026-01-01T00:00:00.000Z',
        dispatchStatus: 'outcome_unknown',
      }),
    });

    const recovered = parseToolResult(
      await review.execute({ ...contentArgs, reviewObligationId: obligationId }, ctx),
    );
    expect(recovered.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    expect(recovered.reviewDispatch).toEqual({ required: true });
    expect(recovered.reviewAttemptId).not.toBe(firstAttemptId);

    const after = await readState(sessDir);
    const attempts = after!.reviewAssurance!.attempts.filter(
      (a) => a.obligationId === obligationId,
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.find((a) => a.attemptId === firstAttemptId)?.status).toBe('stale');
    expect(attempts.find((a) => a.attemptId === recovered.reviewAttemptId)?.origin).toMatchObject({
      kind: 'dispatch_rearm',
      predecessorAttemptId: firstAttemptId,
    });
  });
});
