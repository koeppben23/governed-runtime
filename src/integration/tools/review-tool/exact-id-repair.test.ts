/**
 * @module integration/tools/review-tool/exact-id-repair.test
 * @description Regression: an explicit reviewObligationId DOMINATES content
 *              fingerprint matching in the repair path.
 *
 * The canonical /review retry instruction is a review call carrying the
 * original content plus reviewObligationId and deliberately NO reviewVerdict.
 * The agent may legitimately omit inputOrigin/references metadata, which
 * changes the content fingerprint. Before this fix, that drift created a
 * SECOND obligation for the same review, resetting the per-obligation repair
 * budget and splitting the reviewer lineage. Now: exact ID or fail-closed.
 *
 * Also covers the output-repair stall gate: a targeted repair that reproduces
 * the identical schema error set terminates with REVIEWER_OUTPUT_REPAIR_STALLED
 * instead of burning the retry budget on a third identical LLM run.
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
import { writeStateWithArtifacts } from '../helpers.js';
import { resolvePolicyFromState } from '../helpers.js';
import { findReviewObligationById, ensureReviewAssurance } from '../../review/assurance.js';
import type { SessionState } from '../../../state/schema.js';

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
      source: 'env',
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

/** Mark the latest attempt of an obligation as rejected with a schema fingerprint. */
async function rejectLatestAttempt(
  sessDir: string,
  obligationId: string,
  schemaErrorFingerprint: string,
): Promise<void> {
  const state = await readState(sessDir);
  const attempts = ensureReviewAssurance(state?.reviewAssurance).attempts;
  const latest = attempts
    .filter((a) => a.obligationId === obligationId)
    .reduce((best, a) => (a.ordinal > best.ordinal ? a : best));
  await writeStateWithArtifacts(sessDir, {
    ...state!,
    reviewAssurance: {
      ...ensureReviewAssurance(state!.reviewAssurance),
      attempts: attempts.map((a) =>
        a.attemptId !== latest.attemptId
          ? a
          : {
              ...a,
              status: 'rejected' as const,
              completedAt: '2026-01-01T00:00:00.000Z',
              rejectionReason: 'schema_invalid' as const,
              schemaErrorFingerprint,
            },
      ),
    },
  });
}

describe('exact obligation identity dominates fingerprint matching', () => {
  it('HAPPY: repair call with explicit ID reissues on the SAME obligation (demo sequence)', async () => {
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

    await rejectLatestAttempt(sessDir, obligationId, 'f'.repeat(64));

    // The documented retry shape: original content field + reviewObligationId,
    // WITHOUT the inputOrigin/references metadata of the first call.
    const repair = parseToolResult(
      await review.execute(
        { branch: 'feature/add-due-date', reviewObligationId: obligationId },
        ctx,
      ),
    );
    expect(repair.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    expect(requiredString(repair.requiredReviewAttestation, 'toolObligationId')).toBe(obligationId);

    const afterRepair = await readState(sessDir);
    expect(afterRepair!.reviewAssurance!.obligations).toHaveLength(1);
    expect(afterRepair!.reviewAssurance!.obligations[0]!.obligationId).toBe(obligationId);
    const attempts = afterRepair!.reviewAssurance!.attempts.filter(
      (a) => a.obligationId === obligationId,
    );
    expect(attempts.map((a) => a.ordinal).sort()).toEqual([1, 2]);
    const repairAttempt = attempts.find((a) => a.ordinal === 2);
    expect(repairAttempt?.status).toBe('created');
    expect(repairAttempt?.origin.kind).toBe('output_repair');
    if (repairAttempt?.origin.kind === 'output_repair') {
      expect(repairAttempt.origin.predecessorAttemptId).toBe(firstAttempt!.attemptId);
      expect(repairAttempt.origin.triggerReason).toBe('schema_invalid');
    }
    expect(repairAttempt?.attemptId).not.toBe(firstAttempt!.attemptId);
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

  it('HAPPY: verdict continuation with explicit ID is untouched (input mismatch still guarded)', async () => {
    await hydrateTeam();
    const first = parseToolResult(
      await review.execute({ branch: 'feature/auth', inputOrigin: 'branch' }, ctx),
    );
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    const result = parseToolResult(
      await review.execute(
        {
          branch: 'different-branch',
          inputOrigin: 'branch',
          reviewObligationId: obligationId,
          reviewVerdict: 'accept',
        },
        ctx,
      ),
    );
    expect(result.code).toBe('REVIEW_OBLIGATION_INPUT_MISMATCH');
  });
});

/** Raise the frozen output-repair budget (test manipulation of frozen state). */
async function raiseRepairBudget(
  sessDir: string,
  obligationId: string,
  budget: number,
): Promise<void> {
  const state = await readState(sessDir);
  await writeStateWithArtifacts(sessDir, {
    ...state!,
    reviewAssurance: {
      ...ensureReviewAssurance(state!.reviewAssurance),
      obligations: ensureReviewAssurance(state!.reviewAssurance).obligations.map((o) =>
        o.obligationId !== obligationId ? o : { ...o, maxReviewerOutputRepairAttempts: budget },
      ),
    },
  });
}

describe('output-repair stall detection', () => {
  async function startRepairedObligation(): Promise<{
    sessDir: string;
    obligationId: string;
    firstAttemptId: string;
  }> {
    await hydrateTeam();
    const first = parseToolResult(
      await review.execute(
        {
          branch: 'feature/stall',
          inputOrigin: 'branch',
          references: [{ ref: 'feature/stall', type: 'branch' as const, source: 'local' }],
        },
        ctx,
      ),
    );
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    const sessDir = await currentSessionDir();
    const firstAttempt = (await readState(sessDir))!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId,
    )!;
    await rejectLatestAttempt(sessDir, obligationId, 'f'.repeat(64));
    const repair = parseToolResult(
      await review.execute({ branch: 'feature/stall', reviewObligationId: obligationId }, ctx),
    );
    expect(repair.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    return { sessDir, obligationId, firstAttemptId: firstAttempt.attemptId };
  }

  it('BAD: repair reproducing the identical schema error set stalls terminally', async () => {
    const { sessDir, obligationId } = await startRepairedObligation();
    await rejectLatestAttempt(sessDir, obligationId, 'f'.repeat(64));

    const stalled = parseToolResult(
      await review.execute({ branch: 'feature/stall', reviewObligationId: obligationId }, ctx),
    );
    expect(stalled.code).toBe('REVIEWER_OUTPUT_REPAIR_STALLED');

    const state = await readState(sessDir);
    const obligation = findReviewObligationById(state!.reviewAssurance, obligationId);
    expect(obligation?.status).toBe('blocked');
    expect(obligation?.blockedCode).toBe('REVIEWER_OUTPUT_REPAIR_STALLED');
    // No third attempt was minted.
    const attempts = state!.reviewAssurance!.attempts.filter(
      (a) => a.obligationId === obligationId,
    );
    expect(attempts).toHaveLength(2);
  });

  it('HAPPY: a DIFFERENT schema error set is not a stall — the frozen budget applies', async () => {
    const { sessDir, obligationId } = await startRepairedObligation();
    await rejectLatestAttempt(sessDir, obligationId, 'a'.repeat(64));

    // Budget is 1 (team default): the stall gate must NOT fire, but the
    // frozen budget semantics do.
    const exhausted = parseToolResult(
      await review.execute({ branch: 'feature/stall', reviewObligationId: obligationId }, ctx),
    );
    expect(exhausted.code).toBe('REVIEWER_OUTPUT_RETRY_EXHAUSTED');
    expect(exhausted.code).not.toBe('REVIEWER_OUTPUT_REPAIR_STALLED');
  });

  it('HAPPY: a different error set mints a third attempt when the frozen budget allows', async () => {
    const { sessDir, obligationId } = await startRepairedObligation();
    await raiseRepairBudget(sessDir, obligationId, 2);
    await rejectLatestAttempt(sessDir, obligationId, 'a'.repeat(64));

    const repaired = parseToolResult(
      await review.execute({ branch: 'feature/stall', reviewObligationId: obligationId }, ctx),
    );
    expect(repaired.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    expect(requiredString(repaired.requiredReviewAttestation, 'toolObligationId')).toBe(
      obligationId,
    );
    const attempts = (await readState(sessDir))!.reviewAssurance!.attempts.filter(
      (a) => a.obligationId === obligationId,
    );
    expect(attempts.map((a) => a.ordinal).sort()).toEqual([1, 2, 3]);
  });

  it('EDGE: missing fingerprint fails safe — budget path continues to apply', async () => {
    const { sessDir, obligationId } = await startRepairedObligation();
    await raiseRepairBudget(sessDir, obligationId, 2);
    const state = await readState(sessDir);
    const attempts = ensureReviewAssurance(state?.reviewAssurance).attempts;
    const latest = attempts
      .filter((a) => a.obligationId === obligationId)
      .reduce((best, a) => (a.ordinal > best.ordinal ? a : best));
    await writeState(sessDir, {
      ...state!,
      reviewAssurance: {
        ...ensureReviewAssurance(state!.reviewAssurance),
        attempts: attempts.map((a) =>
          a.attemptId !== latest.attemptId
            ? a
            : {
                ...a,
                status: 'rejected' as const,
                completedAt: '2026-01-01T00:00:00.000Z',
                rejectionReason: 'schema_invalid' as const,
                schemaErrorFingerprint: undefined,
              },
        ),
      },
    } as SessionState);

    const result = parseToolResult(
      await review.execute({ branch: 'feature/stall', reviewObligationId: obligationId }, ctx),
    );
    expect(result.code).toBe('CONTENT_ANALYSIS_REQUIRED');
  });
});

void resolvePolicyFromState;
