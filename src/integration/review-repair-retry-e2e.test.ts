/**
 * @module integration/review-repair-retry-e2e.test
 * @description Contract: the documented reviewer repair retry is executable.
 *
 * When a reviewer Task returns output that fails schema validation, the host
 * marks the attempt `rejected` and the `/review` command instructs the agent to
 * re-run `flowguard_review` with the original content plus reviewObligationId
 * and NO verdict — the agent cannot know a verdict when the reviewer output was
 * unusable. That call must re-arm a bindable attempt, otherwise the obligation
 * dead-ends and no recovery step can clear it.
 *
 * @test-policy HAPPY, EDGE - repair reissue plus the in-flight no-op case.
 */

import * as crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
  withTestEnv,
} from './test-helpers.js';
import { hydrate, review } from './tools/index.js';
import { readState } from '../adapters/persistence.js';
import { writeStateWithArtifacts } from './tools/helpers.js';

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      source: 'env',
    }),
  };
});

const BRANCH_DIFF = vi.hoisted(
  () =>
    'diff --git a/src/auth/login.ts b/src/auth/login.ts\n+branch line\n' +
    'diff --git a/src/auth/types.ts b/src/auth/types.ts\n+branch line',
);

vi.mock('../adapters/gh-cli', () => ({
  hasGhCli: vi.fn().mockReturnValue(true),
  loadBranchDiff: vi.fn().mockReturnValue(BRANCH_DIFF),
  loadResolvedBranchDiff: vi.fn().mockReturnValue(BRANCH_DIFF),
  resolveBranchReviewSource: vi.fn().mockImplementation((branch: string) => ({
    branch,
    baseBranch: 'main',
    resolvedBranchSha: 'a'.repeat(40),
    resolvedBaseSha: 'b'.repeat(40),
    repository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
  })),
  loadBranchChangedFiles: vi.fn().mockReturnValue(['src/auth/login.ts', 'src/auth/types.ts']),
}));

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

async function hydrateSession(): Promise<void> {
  const result = parseToolResult(
    await hydrate.execute({ policyMode: 'team', profileId: 'baseline' }, ctx),
  );
  if (result.error) throw new Error(`Failed to hydrate: ${String(result.message)}`);
}

async function currentSessionDir(): Promise<string> {
  const { computeFingerprint, sessionDir: resolveSessionDir } =
    await import('../adapters/workspace/index.js');
  const fp = await computeFingerprint(ws.tmpDir);
  return resolveSessionDir(fp.fingerprint, ctx.sessionID);
}

function requiredString(value: unknown, key: string): string {
  if (value === null || typeof value !== 'object') throw new TypeError(`Expected ${key}`);
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== 'string') throw new TypeError(`Expected ${key} string`);
  return field;
}

describe('review repair retry (host-task)', () => {
  /**
   * Regression: the documented schema_invalid repair loop must be executable.
   *
   * After a reviewer Task returns unusable output the host marks the attempt
   * `rejected`. The canonical `/review` retry instruction is a review call
   * carrying the original content plus reviewObligationId and deliberately NO
   * reviewVerdict — the agent cannot know a verdict when the reviewer output
   * failed validation. Before this fix that call resolved no bindable attempt,
   * so the obligation dead-ended and every further call reported a frozen
   * material integrity failure that no recovery step could clear.
   */
  it('reissues a bindable attempt when a rejected attempt is retried without a verdict', async () => {
    await hydrateSession();
    const contentArgs = { branch: 'feature-auth', inputOrigin: 'branch' as const };
    const first = parseToolResult(await review.execute(contentArgs, ctx));
    expect(first.code).toBe('CONTENT_ANALYSIS_REQUIRED');

    const sessDir = await currentSessionDir();
    const afterFirst = await readState(sessDir);
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    const firstAttempt = afterFirst!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId,
    );
    expect(firstAttempt?.status).toBe('created');

    // Simulate the host reaction to bindOutcome=schema_invalid. The host
    // persists the structured rejection reason at the rejection point; without
    // it the reissue gate fails closed.
    await writeStateWithArtifacts(sessDir, {
      ...afterFirst!,
      reviewAssurance: {
        ...afterFirst!.reviewAssurance!,
        attempts: afterFirst!.reviewAssurance!.attempts.map((a) =>
          a.attemptId === firstAttempt!.attemptId
            ? {
                ...a,
                status: 'rejected' as const,
                childSessionId: 'reviewer-child-session-1',
                completedAt: '2026-01-01T00:00:00.000Z',
                rejectionReason: 'schema_invalid' as const,
              }
            : a,
        ),
      },
    });

    const repair = parseToolResult(
      await review.execute({ ...contentArgs, reviewObligationId: obligationId }, ctx),
    );

    expect(repair.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    expect(repair.code).not.toBe('REVIEW_MATERIAL_INTEGRITY_FAILED');
    expect(repair.code).not.toBe('REVIEW_ATTEMPT_UNAVAILABLE');

    const afterRepair = await readState(sessDir);
    const attempts = afterRepair!.reviewAssurance!.attempts.filter(
      (a) => a.obligationId === obligationId,
    );
    const bindable = attempts.filter((a) => a.status === 'created' && !a.childSessionId);
    expect(bindable).toHaveLength(1);
    expect(bindable[0]!.attemptId).not.toBe(firstAttempt!.attemptId);
    // The frozen material must carry forward: the reviewer receives the same
    // bytes that were frozen for the original obligation.
    expect(bindable[0]!.reviewMaterial).toEqual(firstAttempt!.reviewMaterial);
    expect(bindable[0]!.subjectDigest).toBe(firstAttempt!.subjectDigest);
    // The obligation itself is never duplicated by a repair call.
    expect(
      afterRepair!.reviewAssurance!.obligations.filter((o) => o.obligationType === 'review'),
    ).toHaveLength(1);
  });

  it('does not stale an open attempt when a review call is repeated', async () => {
    await hydrateSession();
    const contentArgs = { branch: 'feature-auth', inputOrigin: 'branch' as const };
    const first = parseToolResult(await review.execute(contentArgs, ctx));
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    const sessDir = await currentSessionDir();
    const openAttemptId = (await readState(sessDir))!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId,
    )!.attemptId;

    // A repeat call while the reviewer Task is still in flight must not
    // invalidate the attempt that Task is expected to bind to.
    await review.execute({ ...contentArgs, reviewObligationId: obligationId }, ctx);

    const attempts = (await readState(sessDir))!.reviewAssurance!.attempts.filter(
      (a) => a.obligationId === obligationId,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.attemptId).toBe(openAttemptId);
    expect(attempts[0]!.status).toBe('created');
  });

  it('mints the repair attempt with an output_repair origin and trigger reason', async () => {
    await hydrateSession();
    const contentArgs = { branch: 'feature-auth', inputOrigin: 'branch' as const };
    const first = parseToolResult(await review.execute(contentArgs, ctx));
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    const sessDir = await currentSessionDir();
    const afterFirst = await readState(sessDir);
    const firstAttempt = afterFirst!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId,
    )!;
    expect(firstAttempt.origin).toEqual({ kind: 'initial' });

    await writeStateWithArtifacts(sessDir, {
      ...afterFirst!,
      reviewAssurance: {
        ...afterFirst!.reviewAssurance!,
        attempts: afterFirst!.reviewAssurance!.attempts.map((a) =>
          a.attemptId === firstAttempt.attemptId
            ? {
                ...a,
                status: 'rejected' as const,
                childSessionId: 'reviewer-child-session-1',
                completedAt: '2026-01-01T00:00:00.000Z',
                rejectionReason: 'schema_invalid' as const,
              }
            : a,
        ),
      },
    });

    await review.execute({ ...contentArgs, reviewObligationId: obligationId }, ctx);
    const afterRepair = await readState(sessDir);
    const repair = afterRepair!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId && a.status === 'created' && !a.childSessionId,
    )!;
    expect(repair.origin).toEqual({
      kind: 'output_repair',
      predecessorAttemptId: firstAttempt.attemptId,
      triggerReason: 'schema_invalid',
    });
  });

  it('terminates with REVIEWER_OUTPUT_RETRY_EXHAUSTED when the frozen budget is spent', async () => {
    await hydrateSession();
    const contentArgs = { branch: 'feature-auth', inputOrigin: 'branch' as const };
    const first = parseToolResult(await review.execute(contentArgs, ctx));
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    const sessDir = await currentSessionDir();

    // Repair #1: reject the initial attempt with a repairable reason.
    const afterFirst = await readState(sessDir);
    const firstAttempt = afterFirst!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId,
    )!;
    await writeStateWithArtifacts(sessDir, {
      ...afterFirst!,
      reviewAssurance: {
        ...afterFirst!.reviewAssurance!,
        attempts: afterFirst!.reviewAssurance!.attempts.map((a) =>
          a.attemptId === firstAttempt.attemptId
            ? {
                ...a,
                status: 'rejected' as const,
                childSessionId: 'reviewer-child-session-1',
                completedAt: '2026-01-01T00:00:00.000Z',
                rejectionReason: 'schema_invalid' as const,
              }
            : a,
        ),
      },
    });
    const repair1 = parseToolResult(
      await review.execute({ ...contentArgs, reviewObligationId: obligationId }, ctx),
    );
    expect(repair1.code).toBe('CONTENT_ANALYSIS_REQUIRED');

    // Repair #1 also fails with a repairable rejection → budget exhausted.
    const afterRepair1 = await readState(sessDir);
    const repairAttempt = afterRepair1!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId && a.origin.kind === 'output_repair',
    )!;
    await writeStateWithArtifacts(sessDir, {
      ...afterRepair1!,
      reviewAssurance: {
        ...afterRepair1!.reviewAssurance!,
        attempts: afterRepair1!.reviewAssurance!.attempts.map((a) =>
          a.attemptId === repairAttempt.attemptId
            ? {
                ...a,
                status: 'rejected' as const,
                childSessionId: 'reviewer-child-session-2',
                completedAt: '2026-01-02T00:00:00.000Z',
                rejectionReason: 'schema_invalid' as const,
              }
            : a,
        ),
      },
    });

    const exhausted = parseToolResult(
      await review.execute({ ...contentArgs, reviewObligationId: obligationId }, ctx),
    );
    expect(exhausted.code).toBe('REVIEWER_OUTPUT_RETRY_EXHAUSTED');

    const afterExhausted = await readState(sessDir);
    const obligation = afterExhausted!.reviewAssurance!.obligations.find(
      (o) => o.obligationId === obligationId,
    )!;
    expect(obligation.status).toBe('blocked');
    expect(obligation.blockedCode).toBe('REVIEWER_OUTPUT_RETRY_EXHAUSTED');
    // No further attempt may be minted.
    expect(
      afterExhausted!.reviewAssurance!.attempts.filter((a) => a.obligationId === obligationId),
    ).toHaveLength(2);
  });

  it('terminates with REVIEW_REPAIR_UNAVAILABLE on a governance rejection', async () => {
    await hydrateSession();
    const contentArgs = { branch: 'feature-auth', inputOrigin: 'branch' as const };
    const first = parseToolResult(await review.execute(contentArgs, ctx));
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    const sessDir = await currentSessionDir();
    const afterFirst = await readState(sessDir);
    const firstAttempt = afterFirst!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId,
    )!;
    await writeStateWithArtifacts(sessDir, {
      ...afterFirst!,
      reviewAssurance: {
        ...afterFirst!.reviewAssurance!,
        attempts: afterFirst!.reviewAssurance!.attempts.map((a) =>
          a.attemptId === firstAttempt.attemptId
            ? {
                ...a,
                status: 'rejected' as const,
                childSessionId: 'reviewer-child-session-1',
                completedAt: '2026-01-01T00:00:00.000Z',
                rejectionReason: 'scope_invalid' as const,
              }
            : a,
        ),
      },
    });

    const blocked = parseToolResult(
      await review.execute({ ...contentArgs, reviewObligationId: obligationId }, ctx),
    );
    expect(blocked.code).toBe('REVIEW_REPAIR_UNAVAILABLE');

    const afterBlocked = await readState(sessDir);
    const obligation = afterBlocked!.reviewAssurance!.obligations.find(
      (o) => o.obligationId === obligationId,
    )!;
    expect(obligation.status).toBe('blocked');
    expect(obligation.blockedCode).toBe('REVIEW_REPAIR_UNAVAILABLE');
    expect(
      afterBlocked!.reviewAssurance!.attempts.filter((a) => a.obligationId === obligationId),
    ).toHaveLength(1);
  });

  it('terminates with REVIEW_REPAIR_UNAVAILABLE on a rejected attempt without a reason', async () => {
    await hydrateSession();
    const contentArgs = { branch: 'feature-auth', inputOrigin: 'branch' as const };
    const first = parseToolResult(await review.execute(contentArgs, ctx));
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    const sessDir = await currentSessionDir();
    const afterFirst = await readState(sessDir);
    const firstAttempt = afterFirst!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId,
    )!;
    await writeStateWithArtifacts(sessDir, {
      ...afterFirst!,
      reviewAssurance: {
        ...afterFirst!.reviewAssurance!,
        attempts: afterFirst!.reviewAssurance!.attempts.map((a) =>
          a.attemptId === firstAttempt.attemptId
            ? {
                ...a,
                status: 'rejected' as const,
                childSessionId: 'reviewer-child-session-1',
                completedAt: '2026-01-01T00:00:00.000Z',
              }
            : a,
        ),
      },
    });

    const blocked = parseToolResult(
      await review.execute({ ...contentArgs, reviewObligationId: obligationId }, ctx),
    );
    expect(blocked.code).toBe('REVIEW_REPAIR_UNAVAILABLE');
  });

  it('frozen budget stays authoritative when the live policy snapshot changes (1→3)', async () => {
    await hydrateSession();
    const contentArgs = { branch: 'feature-auth', inputOrigin: 'branch' as const };
    const first = parseToolResult(await review.execute(contentArgs, ctx));
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    const sessDir = await currentSessionDir();
    const afterFirst = await readState(sessDir);
    const obligation = afterFirst!.reviewAssurance!.obligations.find(
      (o) => o.obligationId === obligationId,
    )!;
    expect(obligation.maxReviewerOutputRepairAttempts).toBe(1);

    // Simulate a later policy change: the snapshot now allows 3 repairs.
    await writeStateWithArtifacts(sessDir, {
      ...afterFirst!,
      policySnapshot: {
        ...afterFirst!.policySnapshot!,
        maxReviewerOutputRepairAttempts: 3,
      },
    });

    // The frozen obligation value (1) must keep governing: exhaust it with one
    // authorized repair, then the second rejection must exhaust.
    const afterPolicyChange = await readState(sessDir);
    const firstAttempt = afterPolicyChange!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId,
    )!;
    await writeStateWithArtifacts(sessDir, {
      ...afterPolicyChange!,
      reviewAssurance: {
        ...afterPolicyChange!.reviewAssurance!,
        attempts: afterPolicyChange!.reviewAssurance!.attempts.map((a) =>
          a.attemptId === firstAttempt.attemptId
            ? {
                ...a,
                status: 'rejected' as const,
                childSessionId: 'reviewer-child-session-1',
                completedAt: '2026-01-01T00:00:00.000Z',
                rejectionReason: 'schema_invalid' as const,
              }
            : a,
        ),
      },
    });
    const repair1 = parseToolResult(
      await review.execute({ ...contentArgs, reviewObligationId: obligationId }, ctx),
    );
    expect(repair1.code).toBe('CONTENT_ANALYSIS_REQUIRED');

    const afterRepair1 = await readState(sessDir);
    const repairAttempt = afterRepair1!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId && a.origin.kind === 'output_repair',
    )!;
    await writeStateWithArtifacts(sessDir, {
      ...afterRepair1!,
      reviewAssurance: {
        ...afterRepair1!.reviewAssurance!,
        attempts: afterRepair1!.reviewAssurance!.attempts.map((a) =>
          a.attemptId === repairAttempt.attemptId
            ? {
                ...a,
                status: 'rejected' as const,
                childSessionId: 'reviewer-child-session-2',
                completedAt: '2026-01-02T00:00:00.000Z',
                rejectionReason: 'schema_invalid' as const,
              }
            : a,
        ),
      },
    });
    const exhausted = parseToolResult(
      await review.execute({ ...contentArgs, reviewObligationId: obligationId }, ctx),
    );
    expect(exhausted.code).toBe('REVIEWER_OUTPUT_RETRY_EXHAUSTED');
  });

  it('frozen budget stays authoritative when the live policy snapshot changes (1→0)', async () => {
    await hydrateSession();
    const contentArgs = { branch: 'feature-auth', inputOrigin: 'branch' as const };
    const first = parseToolResult(await review.execute(contentArgs, ctx));
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    const sessDir = await currentSessionDir();
    const afterFirst = await readState(sessDir);

    // Simulate a later policy change: the snapshot now forbids repairs.
    await writeStateWithArtifacts(sessDir, {
      ...afterFirst!,
      policySnapshot: {
        ...afterFirst!.policySnapshot!,
        maxReviewerOutputRepairAttempts: 0,
      },
    });

    // The frozen obligation value (1) must keep governing: one repair is still
    // authorized even though the live snapshot now says 0.
    const afterPolicyChange = await readState(sessDir);
    const firstAttempt = afterPolicyChange!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId,
    )!;
    await writeStateWithArtifacts(sessDir, {
      ...afterPolicyChange!,
      reviewAssurance: {
        ...afterPolicyChange!.reviewAssurance!,
        attempts: afterPolicyChange!.reviewAssurance!.attempts.map((a) =>
          a.attemptId === firstAttempt.attemptId
            ? {
                ...a,
                status: 'rejected' as const,
                childSessionId: 'reviewer-child-session-1',
                completedAt: '2026-01-01T00:00:00.000Z',
                rejectionReason: 'schema_invalid' as const,
              }
            : a,
        ),
      },
    });
    const repair = parseToolResult(
      await review.execute({ ...contentArgs, reviewObligationId: obligationId }, ctx),
    );
    expect(repair.code).toBe('CONTENT_ANALYSIS_REQUIRED');
  });

  it('tampered persisted material blocks the repair with zero state mutation', async () => {
    await hydrateSession();
    const contentArgs = { branch: 'feature-auth', inputOrigin: 'branch' as const };
    const first = parseToolResult(await review.execute(contentArgs, ctx));
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    const sessDir = await currentSessionDir();
    const afterFirst = await readState(sessDir);
    const firstAttempt = afterFirst!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligationId,
    )!;
    await writeStateWithArtifacts(sessDir, {
      ...afterFirst!,
      reviewAssurance: {
        ...afterFirst!.reviewAssurance!,
        attempts: afterFirst!.reviewAssurance!.attempts.map((a) =>
          a.attemptId === firstAttempt.attemptId
            ? {
                ...a,
                status: 'rejected' as const,
                childSessionId: 'reviewer-child-session-1',
                completedAt: '2026-01-01T00:00:00.000Z',
                rejectionReason: 'schema_invalid' as const,
              }
            : a,
        ),
      },
    });

    // Tamper the persisted frozen material on the rejected attempt. The
    // obligation-level frozen subject stays intact, so the gate — not the
    // frozen-continuation guard — must refuse with the integrity code.
    const afterRejected = await readState(sessDir);
    await writeStateWithArtifacts(sessDir, {
      ...afterRejected!,
      reviewAssurance: {
        ...afterRejected!.reviewAssurance!,
        attempts: afterRejected!.reviewAssurance!.attempts.map((a) =>
          a.attemptId === firstAttempt.attemptId
            ? {
                ...a,
                reviewMaterial: {
                  ...a.reviewMaterial!,
                  content: 'TAMPERED frozen material\n',
                },
              }
            : a,
        ),
      },
    });

    const blocked = parseToolResult(
      await review.execute({ ...contentArgs, reviewObligationId: obligationId }, ctx),
    );
    expect(blocked.code).toBe('REVIEW_MATERIAL_INTEGRITY_FAILED');

    // ZERO state mutation: same attempt IDs, same ordinals, same statuses,
    // no stale mutation, obligation still pending (NOT blocked).
    const afterRepairAttempt = await readState(sessDir);
    const attempts = afterRepairAttempt!.reviewAssurance!.attempts.filter(
      (a) => a.obligationId === obligationId,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.attemptId).toBe(firstAttempt.attemptId);
    expect(attempts[0]!.ordinal).toBe(firstAttempt.ordinal);
    expect(attempts[0]!.status).toBe('rejected');
    const obligation = afterRepairAttempt!.reviewAssurance!.obligations.find(
      (o) => o.obligationId === obligationId,
    )!;
    expect(obligation.status).toBe('pending');
    expect(obligation.blockedCode).toBeNull();
  });
});
