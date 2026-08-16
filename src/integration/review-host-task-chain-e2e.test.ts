/**
 * @module integration/review-host-task-chain-e2e.test
 * @description Contract: the complete host-task review chain, end to end.
 *
 * Drives /review from obligation creation through bound reviewer evidence to
 * verdict submission and REVIEW_COMPLETE. Every prior defect on this path was
 * covered per stage but never as a chain, so each one stayed hidden behind the
 * previous until the chain was executed.
 *
 * Parameterised over both repository identities: a remote-identified branch and
 * a local one (no parseable origin), which freeze different identity shapes.
 *
 * @test-policy HAPPY - full-chain completion per identity shape.
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
import {
  REVIEW_MANDATE_DIGEST,
  REVIEW_CRITERIA_VERSION,
  appendInvocationEvidence,
  buildInvocationEvidence,
  ensureReviewAssurance,
  hashFindings,
} from './review/assurance.js';
import { hydrate, review } from './tools/index.js';
import { readState, writeState } from '../adapters/persistence.js';

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
    'diff --git a/docs/test.md b/docs/test.md\n+branch line\n' +
    'diff --git a/src/auth/login.ts b/src/auth/login.ts\n+branch line',
);

vi.mock('../adapters/gh-cli', () => ({
  loadResolvedBranchDiff: vi.fn().mockReturnValue(BRANCH_DIFF),
  resolveBranchReviewSource: vi.fn().mockImplementation((branch: string) => ({
    branch,
    baseBranch: 'main',
    resolvedBranchSha: 'a'.repeat(40),
    resolvedBaseSha: 'b'.repeat(40),
    repository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
  })),
  loadBranchChangedFiles: vi.fn().mockReturnValue(['docs/test.md', 'src/auth/login.ts']),
}));

const ghMock = await import('../adapters/gh-cli.js');

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

async function hydrateSession(_overrides?: { policyMode?: string; profileId?: string }) {
  const result = parseToolResult(
    await hydrate.execute({ policyMode: 'team', profileId: 'baseline' }, ctx),
  );
  if (result.error) throw new Error(`Failed to hydrate: ${String(result.message)}`);
  return result;
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

const REVIEW_RELATION = {
  subjectAnchors: [
    {
      kind: 'repository_location' as const,
      location: { path: 'docs/test.md', revision: 'head' },
    },
  ],
  evidenceLocations: [],
};

function buildAnalysisFindings(
  overallVerdict: 'accept' | 'changes_requested',
  toolObligationId: string,
) {
  return {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent' as const,
    overallVerdict,
    blockingIssues:
      overallVerdict === 'changes_requested'
        ? [
            {
              severity: 'major' as const,
              category: 'risk' as const,
              message: 'Critical security flaw in authentication flow',
              relation: REVIEW_RELATION,
            },
          ]
        : [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'flowguard-reviewer-session-123' },
    reviewedAt: '2026-01-01T00:00:00.000Z',
    attestation: {
      toolObligationId,
      iteration: 1,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
    },
  };
}

async function bindHostTaskReviewEvidence(
  obligationId: string,
  findings = buildAnalysisFindings('accept', obligationId),
) {
  const sessDir = await currentSessionDir();
  const state = await readState(sessDir);
  if (!state) throw new TypeError('Expected persisted session state');
  const obligation = state.reviewAssurance?.obligations.find(
    (item) => item.obligationId === obligationId,
  );
  if (!obligation) throw new TypeError('Expected persisted review obligation');
  const invocation = buildInvocationEvidence({
    obligationId,
    obligationType: 'review',
    mandateDigest: obligation.mandateDigest,
    criteriaVersion: obligation.criteriaVersion,
    parentSessionId: ctx.sessionID,
    childSessionId: 'ses_review_child_host_task',
    invocationMode: 'host_subagent_task',
    hostVisible: true,
    promptHash: 'host-task-review-prompt',
    findingsHash: hashFindings(findings),
    invokedAt: '2026-01-01T00:00:00.000Z',
    fulfilledAt: '2026-01-01T00:00:00.000Z',
    source: 'host-orchestrated',
    capturedVerdict: findings.overallVerdict,
    capturedRawFindings: findings,
    attemptId: state.reviewAssurance?.attempts?.find((a) => a.obligationId === obligationId)
      ?.attemptId,
  });
  await writeState(sessDir, {
    ...state,
    reviewAssurance: appendInvocationEvidence(
      ensureReviewAssurance(state.reviewAssurance),
      invocation,
    ),
  });
  return invocation;
}

describe('host-task review chain (end to end)', () => {
  it('host_task_required branch review completes with host evidence and verdict only', async () => {
    await hydrateSession({ policyMode: 'team', profileId: 'baseline' });
    const first = parseToolResult(
      await review.execute(
        { branch: 'feature-auth', inputOrigin: 'branch', targetPaths: ['docs/test.md'] },
        ctx,
      ),
    );
    expect(first.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    expect(first.reviewObligationId).toBe(obligationId);
    await bindHostTaskReviewEvidence(obligationId);

    // The verdict continuation must reuse the persisted frozen subject, so no
    // diff is reloaded. This guards `loadResolvedBranchDiff` — the function
    // the branch loader actually calls; the previous guard asserted on a diff
    // loader this path never invokes, so it asserted nothing.
    const diffLoadsBeforeVerdict = vi.mocked(ghMock.loadResolvedBranchDiff).mock.calls.length;

    const result = parseToolResult(
      await review.execute(
        {
          branch: 'feature-auth',
          inputOrigin: 'branch',
          reviewObligationId: obligationId,
          reviewVerdict: 'accept',
        },
        ctx,
      ),
    );

    expect(result.error).toBeUndefined();
    expect(result.phase).toBe('REVIEW_COMPLETE');
    expect(vi.mocked(ghMock.loadResolvedBranchDiff).mock.calls.length).toBe(diffLoadsBeforeVerdict);
    expect(result.reviewCard).toContain('host_subagent_task');
    expect(result.reviewCard).toContain('ses_review_child_host_task');

    // Regression guard for the consumeValidatedReviewObligation write path
    // (obligation.ts): a completed host-task standalone /review must persist
    // the resolved reviewer findings into standaloneReviewFindings. Without
    // this assertion the append is executed but its effect is unverified, so
    // dropping or corrupting the write survives the suite.
    const persistedSessDir = await currentSessionDir();
    const persistedState = await readState(persistedSessDir);
    expect(persistedState).not.toBeNull();
    const persistedFindings = persistedState!.standaloneReviewFindings ?? [];
    expect(persistedFindings).toHaveLength(1);
    expect(persistedFindings[0]!.overallVerdict).toBe('accept');
    expect(persistedFindings[0]!.attestation?.toolObligationId).toBe(obligationId);
  });

  /**
   * Regression: the same full chain for a repository WITHOUT a parseable
   * remote. Creation freezes a local repository identity
   * ({ kind: 'local', rootCommitDigest }); the verdict continuation must
   * accept it. The pre-existing full-chain coverage only used a remote
   * identity, so the continuation dropped the local one and produced a frozen
   * subject without baseRepository.
   */
  it('host_task_required branch review completes for a local repository without remote identity', async () => {
    await hydrateSession({ policyMode: 'team', profileId: 'baseline' });
    vi.mocked(ghMock.resolveBranchReviewSource).mockReturnValue({
      branch: 'feature-local',
      baseBranch: 'main',
      resolvedBranchSha: 'a'.repeat(40),
      resolvedBaseSha: 'b'.repeat(40),
      repository: { kind: 'local', rootCommitDigest: 'c'.repeat(64) },
    });

    const first = parseToolResult(
      await review.execute(
        { branch: 'feature-local', inputOrigin: 'branch', targetPaths: ['docs/test.md'] },
        ctx,
      ),
    );
    expect(first.code).toBe('CONTENT_ANALYSIS_REQUIRED');
    const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
    await bindHostTaskReviewEvidence(obligationId);

    const result = parseToolResult(
      await review.execute(
        {
          branch: 'feature-local',
          inputOrigin: 'branch',
          reviewObligationId: obligationId,
          reviewVerdict: 'accept',
        },
        ctx,
      ),
    );

    expect(result.error).toBeUndefined();
    expect(result.phase).toBe('REVIEW_COMPLETE');
  });
});
