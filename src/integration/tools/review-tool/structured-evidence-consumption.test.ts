/**
 * @module integration/tools/review-tool/structured-evidence-consumption.test
 * @description Contract: a verdict-only re-invocation resolves host-captured
 *              structured evidence and consumes the review obligation.
 *
 * The parent never submits findings. Once the host captures the reviewer's
 * structured output and binds it to the obligation, flowguard_review with the
 * explicit reviewObligationId must complete the review, persist the resolved
 * findings as standaloneReviewFindings, and mark the invocation consumed.
 *
 * @test-policy HAPPY, BAD
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
import { review, hydrate } from '../index.js';
import { readState } from '../../../adapters/persistence.js';
import { writeStateWithArtifacts } from '../helpers.js';
import {
  REVIEW_CRITERIA_VERSION,
  REVIEW_MANDATE_DIGEST,
  appendInvocationEvidence,
  buildInvocationEvidence,
  ensureReviewAssurance,
  fulfillObligation,
  hashFindings,
  updateAttemptStatus,
} from '../../review/assurance.js';
import { completedDispatchForInvocation } from '../../../state/evidence-test-constants.js';
import type { ReviewFindings } from '../../../state/evidence.js';

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

const REVIEWER_SESSION_ID = 'flowguard-reviewer-session-123';

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

function buildFindings(obligationId: string): ReviewFindings {
  return {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    reviewedBy: { sessionId: REVIEWER_SESSION_ID },
    reviewedAt: '2026-01-01T00:00:00.000Z',
    attestation: {
      toolObligationId: obligationId,
      iteration: 1,
      planVersion: 1,
      reviewedBy: 'flowguard-reviewer',
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
    },
  } as ReviewFindings;
}

/** Start a branch review and return its pending obligation id. */
async function startObligation(): Promise<string> {
  parseToolResult(await hydrate.execute({ policyMode: 'team', profileId: 'baseline' }, ctx));
  const first = parseToolResult(
    await review.execute(
      {
        branch: 'feature/structured',
        inputOrigin: 'branch',
        references: [{ ref: 'feature/structured', type: 'branch' as const, source: 'local' }],
      },
      ctx,
    ),
  );
  expect(first.code).toBe('CONTENT_ANALYSIS_REQUIRED');
  return requiredString(first.requiredReviewAttestation, 'toolObligationId');
}

/** Bind host-captured structured findings to the obligation's attempt. */
async function bindStructuredEvidence(
  obligationId: string,
  findings: ReviewFindings,
): Promise<string> {
  const sessDir = await currentSessionDir();
  const state = await readState(sessDir);
  if (!state) throw new TypeError('Expected persisted session state');
  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const obligation = assurance.obligations.find((item) => item.obligationId === obligationId);
  if (!obligation) throw new TypeError('Expected persisted review obligation');
  const attempt = assurance.attempts.find((item) => item.obligationId === obligationId);
  if (!attempt) throw new TypeError('Expected persisted review attempt');

  const fulfilledAt = '2026-01-01T00:00:00.000Z';
  const invocation = buildInvocationEvidence({
    obligationId,
    obligationType: 'review',
    mandateDigest: obligation.mandateDigest,
    criteriaVersion: obligation.criteriaVersion,
    parentSessionId: ctx.sessionID,
    childSessionId: REVIEWER_SESSION_ID,
    promptHash: 'a'.repeat(64),
    findingsHash: hashFindings(findings),
    invokedAt: fulfilledAt,
    fulfilledAt,
    capturedRawFindings: findings,
    attemptId: attempt.attemptId,
  });
  const boundAssurance = updateAttemptStatus(assurance, attempt.attemptId, 'bound', fulfilledAt, {
    childSessionId: invocation.childSessionId,
  });
  const withInvocation = appendInvocationEvidence(boundAssurance, invocation);
  await writeStateWithArtifacts(sessDir, {
    ...state,
    reviewAssurance: fulfillObligation(
      {
        ...withInvocation,
        dispatches: [...withInvocation.dispatches, completedDispatchForInvocation(invocation)],
      },
      obligationId,
      invocation.invocationId,
      fulfilledAt,
    ),
  });
  return invocation.invocationId;
}

describe('verdict-only structured evidence consumption', () => {
  it('HAPPY: bound structured evidence resolves and consumes the obligation', async () => {
    const obligationId = await startObligation();
    const invocationId = await bindStructuredEvidence(obligationId, buildFindings(obligationId));

    const output = parseToolResult(
      await review.execute({ branch: 'feature/structured', reviewObligationId: obligationId }, ctx),
    );

    expect(output.error).toBeUndefined();
    expect(output.phase).toBe('REVIEW_COMPLETE');

    const state = (await readState(await currentSessionDir()))!;
    const obligation = state.reviewAssurance!.obligations.find(
      (item) => item.obligationId === obligationId,
    );
    expect(obligation?.status).toBe('consumed');
    const invocation = state.reviewAssurance!.invocations.find(
      (item) => item.invocationId === invocationId,
    );
    expect(invocation?.consumedByObligationId).toBe(obligationId);
    expect(state.standaloneReviewFindings).toHaveLength(1);
    expect(state.standaloneReviewFindings![0]!.reviewedBy.sessionId).toBe(REVIEWER_SESSION_ID);
  });

  it('BAD: explicit obligation without bound evidence blocks with SUBAGENT_EVIDENCE_MISSING', async () => {
    const obligationId = await startObligation();

    const output = parseToolResult(
      await review.execute({ branch: 'feature/structured', reviewObligationId: obligationId }, ctx),
    );

    expect(output.error).toBe(true);
    expect(output.code).toBe('SUBAGENT_EVIDENCE_MISSING');
    const state = (await readState(await currentSessionDir()))!;
    const obligation = state.reviewAssurance!.obligations.find(
      (item) => item.obligationId === obligationId,
    );
    expect(obligation?.status).not.toBe('consumed');
  });
});
