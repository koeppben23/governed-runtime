import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { request } from 'node:https';
import {
  createToolContext,
  createTestWorkspace,
  isTarAvailable,
  parseToolResult,
  isBlockedResult,
  fulfillStrictReviewObligation,
  freezeRepositoryReviewObligation,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
  withTestEnv,
} from './test-helpers.js';
vi.mock('node:https', () => ({ request: vi.fn() }));
import {
  REVIEW_MANDATE_DIGEST,
  REVIEW_CRITERIA_VERSION,
  appendInvocationEvidence,
  buildInvocationEvidence,
  ensureReviewAssurance,
  fulfillObligation,
  hashFindings,
} from './review/obligations/assurance.js';
import { ReviewAttestation, ReviewInvocationEvidence } from '../state/evidence.js';
import { findLatestPendingReviewObligation } from './review/obligations/assurance.js';
import {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  implement,
  review,
  abort_session,
  archive,
} from './tools/index.js';
import { readState, writeState } from '../adapters/persistence.js';
import {
  makeState,
  makeProgressedState,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  REVIEW_APPROVE,
  VALIDATION_PASSED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
} from '../fixtures.js';
import { completedDispatchForInvocation } from '../state/evidence-test-constants.js';
import { resolvePolicyFromState, writeStateWithArtifacts } from './tools/helpers.js';

/** Test predicate for source-tagged peer review report findings. */
function hasMaterialFinding(
  findings: Array<Record<string, unknown>>,
  message: string,
  category?: string,
  reportSeverity?: string,
): boolean {
  return findings.some((finding) => {
    if (finding.source !== 'material_finding') return false;
    const material = finding.finding as Record<string, unknown>;
    return (
      material.message === message &&
      (category === undefined || material.category === category) &&
      (reportSeverity === undefined || finding.reportSeverity === reportSeverity)
    );
  });
}
vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});
const wsOriginals = vi.hoisted(() => ({
  archiveSession:
    null as unknown as (typeof import('../adapters/workspace/index.js'))['archiveSession'],
  verifyArchive:
    null as unknown as (typeof import('../adapters/workspace/index.js'))['verifyArchive'],
}));
vi.mock('../adapters/workspace', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/workspace/index.js')>();
  wsOriginals.archiveSession = original.archiveSession;
  wsOriginals.verifyArchive = original.verifyArchive;
  return {
    ...original,
    archiveSession: vi.fn(original.archiveSession),
    verifyArchive: vi.fn(original.verifyArchive),
  };
});
const actorOriginal = vi.hoisted(() => ({
  resolveActor: null as unknown as (typeof import('../adapters/actor.js'))['resolveActor'],
}));

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  actorOriginal.resolveActor = original.resolveActor;
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      source: 'env',
      assurance: 'best_effort',
    }),
  };
});

const gitMock = await import('../adapters/git.js');
const ghMock = await import('../adapters/gh-cli.js');
const wsMock = await import('../adapters/workspace/index.js');
const actorMock = await import('../adapters/actor.js');

vi.mock('../adapters/gh-cli', () => ({
  resolvePullRequestReviewSource: vi.fn().mockImplementation((pullRequestNumber: number) => ({
    pullRequestNumber,
    baseRepository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
    headRepository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
    baseSha: 'b'.repeat(40),
    headSha: 'a'.repeat(40),
  })),
  loadResolvedPullRequestDiff: vi
    .fn()
    .mockReturnValue(
      'diff --git a/docs/test.md b/docs/test.md\n+new line\ndiff --git a/src/auth/login.ts b/src/auth/login.ts\n+new line\ndiff --git a/src/auth/types.ts b/src/auth/types.ts\n+new line',
    ),
  resolveBranchReviewSource: vi.fn().mockImplementation((branch: string) => ({
    branch,
    baseBranch: 'main',
    resolvedBranchSha: 'a'.repeat(40),
    resolvedBaseSha: 'b'.repeat(40),
    repository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
  })),
  loadResolvedBranchDiff: vi
    .fn()
    .mockReturnValue(
      'diff --git a/docs/test.md b/docs/test.md\n+resolved line\ndiff --git a/src/auth/login.ts b/src/auth/login.ts\n+resolved line\ndiff --git a/src/auth/types.ts b/src/auth/types.ts\n+resolved line',
    ),
  loadBranchChangedFiles: vi.fn().mockReturnValue(['src/auth/login.ts', 'src/auth/types.ts']),
  loadPrChangedFiles: vi.fn().mockReturnValue(['src/auth/login.ts', 'src/auth/types.ts']),
}));

const tarOk = await isTarAvailable();

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
  vi.mocked(wsMock.archiveSession).mockReset().mockImplementation(wsOriginals.archiveSession);
  vi.mocked(wsMock.verifyArchive).mockReset().mockImplementation(wsOriginals.verifyArchive);
  vi.mocked(actorMock.resolveActor)
    .mockReset()
    .mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    });
  cleanupEnv();
  vi.clearAllMocks();
  await ws.cleanup();
});

async function hydrateSession(
  overrides: { policyMode?: string; profileId?: string } = {},
): Promise<Record<string, unknown>> {
  const args: { policyMode: string; profileId?: string } = {
    policyMode: overrides.policyMode ?? 'solo',
  };
  if (overrides.profileId !== undefined) {
    args.profileId = overrides.profileId;
  }
  const raw = await hydrate.execute(args, ctx);
  return parseToolResult(raw);
}

async function hydrateAndTicket(ticketText = 'Fix the auth bug'): Promise<void> {
  await hydrateSession();
  await ticket.execute({ text: ticketText, source: 'user' }, ctx);
}

async function currentSessionDir(): Promise<string> {
  const { computeFingerprint, sessionDir: resolveSessionDir } =
    await import('../adapters/workspace/index.js');
  const fp = await computeFingerprint(ws.tmpDir);
  return resolveSessionDir(fp.fingerprint, ctx.sessionID);
}

async function fulfillPlanReview(
  iteration = 0,
  overallVerdict: 'accept' | 'changes_requested' = 'accept',
) {
  return fulfillStrictReviewObligation(await currentSessionDir(), {
    obligationType: 'plan',
    iteration,
    planVersion: 1,
    overallVerdict,
  });
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, key: string): string {
  const record = requiredRecord(value, key);
  const field = record[key];
  if (typeof field !== 'string') throw new TypeError(`Expected ${key} string`);
  return field;
}

describe('review (standalone flow)', () => {
  beforeEach(() => {
    vi.mocked(request).mockImplementation(() => {
      const fakeRequest = new EventEmitter() as EventEmitter & {
        setTimeout: () => void;
        end: () => void;
      };
      fakeRequest.setTimeout = () => undefined;
      fakeRequest.end = () => {
        const response = Object.assign(Readable.from(['Mock URL content for review']), {
          statusCode: 200,
          statusMessage: 'OK',
          headers: {},
        });
        queueMicrotask(() => fakeRequest.emit('response', response));
      };
      return fakeRequest as never;
    });
  });

  async function hydrateAndGetReady(): Promise<void> {
    const raw = await hydrate.execute({ policyMode: 'solo' }, ctx);
    const result = parseToolResult(raw);
    if (result.error) {
      throw new Error(`Failed to hydrate: ${result.message}`);
    }
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
    toolObligationId?: string,
  ) {
    const blockingIssues =
      overallVerdict === 'changes_requested'
        ? [
            {
              severity: 'major' as const,
              category: 'risk' as const,
              message: 'Critical security flaw in authentication flow',
              relation: REVIEW_RELATION,
            },
          ]
        : [];

    const fallbackUuid = '11111111-1111-4111-8111-111111111111';

    return {
      iteration: 1,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict,
      blockingIssues,
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      challenges: [],
      reviewedBy: { sessionId: 'flowguard-reviewer-session-123' },
      reviewedAt: '2026-01-01T00:00:00.000Z',
      attestation: {
        toolObligationId: toolObligationId ?? fallbackUuid,
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
    const boundAttempt = state.reviewAssurance?.attempts?.find(
      (attempt) => attempt.obligationId === obligationId,
    );
    if (!boundAttempt) throw new TypeError('Expected persisted review attempt');
    // The structured-evidence contract binds the invocation's child session to
    // the reviewer identity the captured findings attest to.
    const childSessionId = findings.reviewedBy.sessionId;
    const fulfilledAt = '2026-01-01T00:00:00.000Z';
    const invocation = buildInvocationEvidence({
      obligationId,
      obligationType: 'review',
      mandateDigest: obligation.mandateDigest,
      criteriaVersion: obligation.criteriaVersion,
      parentSessionId: ctx.sessionID,
      childSessionId,
      promptHash: 'a'.repeat(64),
      findingsHash: hashFindings(findings),
      invokedAt: fulfilledAt,
      fulfilledAt,
      capturedRawFindings: findings,
      attemptId: boundAttempt.attemptId,
    });
    const assuranceWithEvidence = appendInvocationEvidence(
      {
        ...ensureReviewAssurance(state.reviewAssurance),
        attempts: state.reviewAssurance!.attempts.map((attempt) =>
          attempt.attemptId === boundAttempt.attemptId
            ? {
                ...attempt,
                childSessionId: invocation.childSessionId,
                status: 'bound' as const,
                completedAt: attempt.completedAt ?? fulfilledAt,
              }
            : attempt,
        ),
      },
      invocation,
    );
    await writeState(sessDir, {
      ...state,
      reviewAssurance: fulfillObligation(
        {
          ...assuranceWithEvidence,
          dispatches: [
            ...assuranceWithEvidence.dispatches,
            completedDispatchForInvocation(invocation),
          ],
        },
        obligationId,
        invocation.invocationId,
        fulfilledAt,
      ),
    });
    return invocation;
  }

  async function obtainObligationUuid(contentArg: Record<string, unknown>): Promise<string> {
    await hydrateAndGetReady();
    const enriched = { ...contentArg };
    if (enriched.targetPaths === undefined) {
      enriched.targetPaths = ['docs/test.md'];
    }
    const raw = await review.execute(enriched, ctx);
    const blocked = parseToolResult(raw);
    if (blocked.code !== 'CONTENT_ANALYSIS_REQUIRED') {
      throw new Error(`Expected CONTENT_ANALYSIS_REQUIRED, got ${blocked.code}`);
    }
    const obligationId = requiredString(blocked.requiredReviewAttestation, 'toolObligationId');
    await freezeRepositoryReviewObligation(await currentSessionDir(), obligationId);
    return obligationId;
  }
  async function submitContentReview(
    contentArg: Record<string, unknown>,
    overallVerdict: 'accept' | 'changes_requested' = 'accept',
    findingOverrides?: Partial<Record<string, unknown>>,
  ) {
    const uuid = await obtainObligationUuid(contentArg);
    const findings = { ...buildAnalysisFindings(overallVerdict, uuid), ...findingOverrides };
    await bindHostTaskReviewEvidence(uuid, findings);
    const raw = await review.execute({ ...contentArg, reviewObligationId: uuid }, ctx);
    return parseToolResult(raw);
  }

  describe('HAPPY', () => {
    it('content-aware review with PR number succeeds with bound structured evidence', async () => {
      const result = await submitContentReview({ prNumber: 123, inputOrigin: 'pr' });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
      expect(result.status).toBe('Review flow complete. Report generated.');
      expect(result.findingsCount).toBeGreaterThanOrEqual(0);
      expect(result.reviewSubject).toMatchObject({
        kind: 'repository_change',
        source: { kind: 'pull_request', pullRequestNumber: 123 },
      });
    });

    it('content-aware review with branch succeeds with bound structured evidence', async () => {
      const result = await submitContentReview({ branch: 'feature-auth', inputOrigin: 'branch' });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
      expect(result.reviewSubject).toMatchObject({
        kind: 'repository_change',
        source: { kind: 'branch', branch: 'feature-auth' },
      });
      expect(result.peerReviewCoverage).toEqual({
        targetResolved: true,
        targetFrozen: true,
        repositoryIdentityVerified: true,
        baseSha: 'b'.repeat(40),
        headSha: 'a'.repeat(40),
        changedPathCount: 3,
        objectivesCovered: 3,
        objectivesTotal: 3,
        reviewAssurance: 'structured_high',
        missingVerification: [],
      });
    });

    it('peerReviewCoverage carries reviewer missing-verification messages', async () => {
      const result = await submitContentReview(
        { branch: 'feature-missing-verification', inputOrigin: 'branch' },
        'accept',
        { missingVerification: ['Add regression coverage for the branch review path'] },
      );
      expect(result.error, JSON.stringify(result)).toBeUndefined();
      expect(result.peerReviewCoverage).toEqual({
        targetResolved: true,
        targetFrozen: true,
        repositoryIdentityVerified: true,
        baseSha: 'b'.repeat(40),
        headSha: 'a'.repeat(40),
        changedPathCount: 3,
        objectivesCovered: 3,
        objectivesTotal: 3,
        reviewAssurance: 'structured_high',
        missingVerification: ['Add regression coverage for the branch review path'],
      });
    });

    it('binds branch material findings to the resolved base/head source scope', async () => {
      await hydrateAndGetReady();
      const first = parseToolResult(
        await review.execute(
          { branch: 'feature-auth', inputOrigin: 'branch', targetPaths: ['src/auth/login.ts'] },
          ctx,
        ),
      );
      const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');
      const state = (await readState(await currentSessionDir()))!;
      const obligation = state.reviewAssurance!.obligations.find(
        (item) => item.obligationId === obligationId,
      )!;
      expect(obligation.reviewSubjectScope).toEqual({
        kind: 'repository_change',
        paths: ['src/auth/login.ts'],
        revisions: ['base', 'head'],
      });
      expect(obligation.reviewSubject).toMatchObject({
        kind: 'repository_change',
        baseRepository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
        headRepository: { host: 'github.com', owner: 'flowguard', name: 'governed-runtime' },
        baseSha: 'b'.repeat(40),
        headSha: 'a'.repeat(40),
      });
      expect(obligation.subjectDigest).toBe(obligation.reviewSubject?.subjectDigest);
      expect(obligation.reviewMaterial.materialDigest).toBe(
        obligation.reviewSubject?.materialDigest,
      );
      const findings = {
        ...buildAnalysisFindings('accept', obligationId),
        challenges: [
          {
            challengeId: '22222222-2222-4222-8222-222222222222',
            obligationId,
            scenario: 'The authorization check is absent on the reviewed branch.',
            claim: 'The change preserves authorization.',
            locations: ['src/auth/login.ts'],
            kind: 'content_challenge' as const,
            evidenceRefs: [{ kind: 'content' as const, digest: obligation.subjectDigest }],
            outcome: 'supported' as const,
          },
        ],
        majorRisks: [
          {
            severity: 'major' as const,
            category: 'risk' as const,
            message: 'The branch removes the authorization check.',
            relation: {
              subjectAnchors: [
                {
                  kind: 'repository_location' as const,
                  location: { path: 'src/auth/login.ts', revision: 'head' as const },
                },
              ],
              evidenceLocations: [{ path: 'src/auth/login.ts', revision: 'base' as const }],
            },
          },
        ],
      };
      await bindHostTaskReviewEvidence(obligationId, findings as never);
      const result = parseToolResult(
        await review.execute(
          {
            branch: 'feature-auth',
            inputOrigin: 'branch',
            targetPaths: ['src/auth/login.ts'],
            reviewObligationId: obligationId,
          },
          ctx,
        ),
      );
      expect(result).toMatchObject({ phase: 'PEER_REVIEW_COMPLETE' });
      const afterSubmit = (await readState(await currentSessionDir()))!;
      const invocation = afterSubmit.reviewAssurance!.invocations.find(
        (item) => item.obligationId === obligationId,
      );
      // Host-observed structured capture is the only accepted provenance.
      expect(invocation?.source).toBe('host-orchestrated');
      expect(invocation?.reviewOutputMode).toBe('structured_output');
      expect(invocation?.structuredOutputUsed).toBe(true);
      expect(invocation?.reviewAssuranceLevel).toBe('structured_high');
      // ... and the referenced attempt is bound atomically.
      const boundAttempt = afterSubmit.reviewAssurance!.attempts.find(
        (item) => item.attemptId === invocation?.attemptId,
      );
      expect(boundAttempt?.status).toBe('bound');
      expect(boundAttempt?.completedAt).toBeDefined();
    });

    it('standalone /review Call 1 persists a PENDING review obligation for host evidence binding', async () => {
      await hydrateSession({ policyMode: 'team', profileId: 'baseline' });
      const first = parseToolResult(
        await review.execute({ branch: 'feature-auth', inputOrigin: 'branch' }, ctx),
      );
      expect(first.code).toBe('CONTENT_ANALYSIS_REQUIRED');

      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      const obligations = state!.reviewAssurance?.obligations ?? [];
      const pendingReview = obligations.filter(
        (o) => o.obligationType === 'review' && o.status === 'pending' && o.consumedAt === null,
      );
      expect(
        pendingReview.length,
        `expected exactly one PENDING review obligation after Call 1, got ${pendingReview.length} (total obligations: ${obligations.length})`,
      ).toBe(1);
    });

    it('materializes a local branch without remote identity and scopes risk to its frozen paths', async () => {
      await hydrateSession({ policyMode: 'team', profileId: 'baseline' });
      vi.mocked(ghMock.resolveBranchReviewSource).mockReturnValueOnce({
        branch: 'feature-local',
        baseBranch: 'main',
        resolvedBranchSha: 'a'.repeat(40),
        resolvedBaseSha: 'b'.repeat(40),
        repository: { kind: 'local', rootCommitDigest: 'c'.repeat(64) },
      });

      const first = parseToolResult(
        await review.execute({ branch: 'feature-local', inputOrigin: 'branch' }, ctx),
      );
      expect(first.code).toBe('CONTENT_ANALYSIS_REQUIRED');
      expect(ghMock.loadBranchChangedFiles).not.toHaveBeenCalled();

      const state = await readState(await currentSessionDir());
      const obligation = findLatestPendingReviewObligation(state!.reviewAssurance, 'review');
      expect(obligation?.reviewSubject).toMatchObject({
        kind: 'repository_change',
        baseSha: 'b'.repeat(40),
        headSha: 'a'.repeat(40),
        changedPaths: ['docs/test.md', 'src/auth/login.ts', 'src/auth/types.ts'],
      });
      expect(obligation?.reviewSubject).toMatchObject({
        baseRepository: { kind: 'local', rootCommitDigest: 'c'.repeat(64) },
      });
      expect(obligation?.metadata?.targetPaths).toEqual([
        'docs/test.md',
        'src/auth/login.ts',
        'src/auth/types.ts',
      ]);
    });

    it('does not start a review when content risk classification blocks, including after hydrate', async () => {
      await hydrateSession({ policyMode: 'team', profileId: 'baseline' });
      const blocked = parseToolResult(
        await review.execute({ text: 'unscoped review content', inputOrigin: 'manual_text' }, ctx),
      );
      expect(blocked.code).toBe('RISK_CLASSIFICATION_EVIDENCE_UNAVAILABLE');

      const sessDir = await currentSessionDir();
      expect((await readState(sessDir))?.phase).toBe('READY');

      const rehydrated = parseToolResult(
        await hydrate.execute({ policyMode: 'team', claimedTaskClass: 'STANDARD' }, ctx),
      );
      expect(rehydrated.phase).toBe('READY');
      expect((await readState(sessDir))?.reviewReportPath).toBeNull();
    });

    it('structured-evidence capture with an unknown obligation ID fails closed', async () => {
      await hydrateSession({ policyMode: 'team', profileId: 'baseline' });
      const first = parseToolResult(
        await review.execute({ branch: 'feature-auth', inputOrigin: 'branch' }, ctx),
      );
      expect(first.code).toBe('CONTENT_ANALYSIS_REQUIRED');

      const result = parseToolResult(
        await review.execute(
          {
            branch: 'feature-auth',
            inputOrigin: 'branch',
            reviewObligationId: '00000000-0000-4000-8000-000000000999',
          },
          ctx,
        ),
      );

      expect(result.code).toBe('REVIEW_OBLIGATION_NOT_FOUND');
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      expect(
        (state!.reviewAssurance?.obligations ?? []).filter((o) => o.obligationType === 'review'),
      ).toHaveLength(1);
    });

    it('F12 REGRESSION: captured structured findings with accept + blocking issue → blocked, coherent code, not misrouted', async () => {
      // The standalone /review structured-evidence path resolves findings from
      // host-captured SDK invocation evidence. An `accept` verdict carrying a
      // blocking issue is self-contradictory and must fail closed with the
      // canonical coherence code before the report completes.
      await hydrateSession({ policyMode: 'team', profileId: 'baseline' });
      const first = parseToolResult(
        await review.execute(
          { text: 'manual diff', inputOrigin: 'manual_text', targetPaths: ['docs/test.md'] },
          ctx,
        ),
      );
      expect(first.code).toBe('CONTENT_ANALYSIS_REQUIRED');
      const obligationId = requiredString(first.requiredReviewAttestation, 'toolObligationId');

      // Seed captured evidence with the exact demo defect: accept verdict
      // carrying a blocking issue (the reviewer honestly returned a
      // self-contradictory record).
      const findings = {
        iteration: 1,
        planVersion: 1,
        reviewMode: 'subagent' as const,
        overallVerdict: 'accept' as const,
        blockingIssues: [
          {
            severity: 'minor' as const,
            category: 'quality' as const,
            message: 'stale comment in test',
            relation: REVIEW_RELATION,
          },
        ],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
        challenges: [],
        reviewedBy: { sessionId: 'flowguard-reviewer-session-123' },
        reviewedAt: '2026-01-01T00:00:00.000Z',
        attestation: {
          toolObligationId: obligationId,
          iteration: 1,
          planVersion: 1,
          reviewedBy: 'flowguard-reviewer',
          mandateDigest: REVIEW_MANDATE_DIGEST,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
        },
      };
      await bindHostTaskReviewEvidence(obligationId, findings as never);

      const result = parseToolResult(
        await review.execute(
          {
            text: 'manual diff',
            inputOrigin: 'manual_text',
            reviewObligationId: obligationId,
          },
          ctx,
        ),
      );

      // 1. Must be blocked with the canonical coherence code — NOT the generic
      //    SUBAGENT_EVIDENCE_MISSING that would claim "evidence is required".
      expect(result.error).toBe(true);
      expect(result.code).toBe('SUBAGENT_VERDICT_FINDINGS_INCOHERENT');

      // 2. Must NOT reach REVIEW_COMPLETE (no phase field on a blocked result,
      //    or phase should NOT be REVIEW_COMPLETE).
      expect(result.phase).not.toBe('PEER_REVIEW_COMPLETE');
      expect(result.reviewCard).toBeUndefined();
    });

    it('content-aware review with URL succeeds with bound structured evidence', async () => {
      const result = await submitContentReview({
        url: 'https://example.com/api-doc',
        inputOrigin: 'external_reference',
      });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
      expect(result.reviewSubject).toMatchObject({
        kind: 'content',
        source: { kind: 'url' },
      });
    });

    it('content-aware review with manual text succeeds', async () => {
      const result = await submitContentReview({
        text: 'Manual review text content',
        inputOrigin: 'manual_text',
      });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
      expect(result.reviewSubject).toMatchObject({
        kind: 'content',
        source: { kind: 'inline', mediaType: 'text' },
      });
    });

    it('persists append-only deterministic prepared and completed review evidence', async () => {
      const content = { text: 'Manual review text content', inputOrigin: 'manual_text' as const };
      const obligationId = await obtainObligationUuid(content);
      const sessDir = await currentSessionDir();
      const preparedState = await readState(sessDir);
      const preparedEvidence = preparedState!.peerReviewEvidence;

      expect(preparedEvidence).toHaveLength(1);
      expect(preparedEvidence[0]).toMatchObject({
        kind: 'prepared',
        task: {
          profileVersion: 'standalone-review-objectives.v1',
          objectives: expect.any(Array),
        },
        obligationId,
        schemaVersion: 'standalone-review-evidence.v2',
      });
      const prepared = preparedEvidence[0];
      if (prepared?.kind !== 'prepared') throw new TypeError('Expected prepared review evidence');
      expect(prepared.task.claims).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ signalClass: 'hypothesis', provenance: null }),
        ]),
      );
      // Content reviews mint attempts with `not_applicable` Discovery context:
      // the field is structurally required, never silently absent.
      const contentAttempt = preparedState!.reviewAssurance!.attempts.find(
        (attempt) => attempt.obligationId === obligationId,
      );
      expect(contentAttempt?.repositoryDiscovery).toEqual({ kind: 'not_applicable' });

      await bindHostTaskReviewEvidence(obligationId, buildAnalysisFindings('accept', obligationId));
      await review.execute({ ...content, reviewObligationId: obligationId }, ctx);
      const completedState = await readState(sessDir);
      const completedEvidence = completedState!.peerReviewEvidence;

      expect(completedEvidence).toHaveLength(2);
      expect(completedEvidence[0]).toEqual(preparedEvidence[0]);
      const completed = completedEvidence[1]!;
      expect(completed).toMatchObject({
        kind: 'completed',
        preparedEvidenceId: prepared.evidenceId,
        obligationId,
        reviewTaskId: prepared.reviewTaskId,
      });
      if (completed.kind !== 'completed') throw new TypeError('Expected completed review evidence');
      expect(completed.findingsDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(completed.attestationDigest).toMatch(/^[a-f0-9]{64}$/);
    });

    it('non-content review (no external content) succeeds without structured evidence', async () => {
      await hydrateAndGetReady();

      const raw = await review.execute({}, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
      expect(result.status).toBe('Review flow complete. Report generated.');
    });

    it('review with references + inputOrigin but no content fields is blocked (REVIEW_CONTENT_SOURCE_INCOMPLETE)', async () => {
      await hydrateAndGetReady();

      const raw = await review.execute(
        {
          references: [{ ref: 'https://github.com/owner/repo/issues/123', type: 'issue' }],
          inputOrigin: 'external_reference',
        },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_CONTENT_SOURCE_INCOMPLETE');
    });
  });

  describe('BAD', () => {
    it('BLOCKED: content-aware review without bound structured evidence', async () => {
      await hydrateAndGetReady();

      const raw = await review.execute({ prNumber: 123, inputOrigin: 'pr' }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe('pending_review');
      expect(result.code).toBe('CONTENT_ANALYSIS_REQUIRED');
      expect(result.recovery).toBeDefined();
      if (!Array.isArray(result.recovery)) throw new TypeError('Expected recovery array');
      expect(result.recovery.length).toBeGreaterThan(0);
    });

    it('PR number with bound structured evidence (subagent found no issues)', async () => {
      const result = await submitContentReview({ prNumber: 456, inputOrigin: 'pr' });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
    });

    it('BLOCKED: review in wrong phase (not READY)', async () => {
      await hydrateSession();
      await ticket.execute({ text: 'Some ticket', source: 'user' }, ctx);

      const raw = await review.execute({ prNumber: 123 }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });
  });

  describe('CORNER', () => {
    it('mixed input: text AND references with inputOrigin="mixed"', async () => {
      const result = await submitContentReview({
        text: 'Mixed content review',
        references: [{ ref: 'PR#789', type: 'pr' }],
        inputOrigin: 'mixed',
      });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
      expect(result.reviewSubject).toMatchObject({
        kind: 'content',
        source: { kind: 'inline', mediaType: 'text' },
      });
    });

    it('response includes the frozen repository subject when provided', async () => {
      const result = await submitContentReview({
        prNumber: 999,
        references: [
          { ref: 'https://github.com/owner/repo/pull/999', type: 'pr', title: 'PR #999' },
        ],
        inputOrigin: 'pr',
      });
      expect(result.error).toBeUndefined();
      expect(result.reviewSubject).toMatchObject({
        kind: 'repository_change',
        source: { kind: 'pull_request', pullRequestNumber: 999 },
      });
    });
  });

  describe('EDGE', () => {
    it('review with repository fields and references populated', async () => {
      const result = await submitContentReview({
        prNumber: 123,
        inputOrigin: 'pr',
        targetPaths: ['docs/test.md'],
        references: [
          { ref: 'PR#123', type: 'pr', title: 'Main PR' },
          { ref: 'JIRA-456', type: 'ticket', title: 'Related ticket' },
        ],
      });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
      expect(result.reviewSubject).toMatchObject({
        kind: 'repository_change',
        source: { kind: 'pull_request', pullRequestNumber: 123 },
      });
    });
  });

  describe('E2E', () => {
    it('full content-aware review flow: hydrate → review with content', async () => {
      const result = await submitContentReview(
        {
          prNumber: 42,
          inputOrigin: 'pr',
          references: [{ ref: 'https://github.com/owner/repo/pull/42', type: 'pr' }],
        },
        'accept',
      );

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
      expect(result.overallStatus).toBeDefined();
      expect(result.peerReviewCoverage).toEqual({
        targetResolved: true,
        targetFrozen: true,
        repositoryIdentityVerified: true,
        baseSha: 'b'.repeat(40),
        headSha: 'a'.repeat(40),
        changedPathCount: 3,
        objectivesCovered: 3,
        objectivesTotal: 3,
        reviewAssurance: 'structured_high',
        missingVerification: [],
      });
      expect(result.completeness).toBeUndefined();
      expect(result.findings).toBeDefined();
      expect(Array.isArray(result.findings)).toBe(true);
      if (!Array.isArray(result.findings)) throw new TypeError('Expected review findings');
      // F11: a standalone content review no longer emits the lifecycle
      // "No ticket evidence" / "No plan evidence" warnings (they contradicted the
      // report's own 0/0-complete projection). With no other mechanical findings,
      // the findings list is legitimately empty for this PR content review.
      const messages = (result.findings as Array<{ message?: string }>).map((f) => f.message);
      expect(messages).not.toContain('No ticket evidence');
      expect(messages).not.toContain('No plan evidence');
      expect(result.reviewSubject).toMatchObject({
        kind: 'repository_change',
        source: { kind: 'pull_request', pullRequestNumber: 42 },
      });
    });
  });

  describe('SMOKE', () => {
    it('smoke: minimal review without content completes', async () => {
      await hydrateAndGetReady();

      const raw = await review.execute({}, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
      expect(result.status).toContain('Review flow complete');
    });

    it('smoke: report contains expected fields', async () => {
      await hydrateAndGetReady();

      const raw = await review.execute({}, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.overallStatus).toMatch(/clean|warnings|issues/);
      expect(result.peerReviewCoverage).toEqual({
        targetResolved: false,
        targetFrozen: false,
        repositoryIdentityVerified: null,
        baseSha: null,
        headSha: null,
        changedPathCount: 0,
        objectivesCovered: 0,
        objectivesTotal: 0,
        reviewAssurance: null,
        missingVerification: [],
      });
      expect(result.completeness).toBeUndefined();
      expect(result.validationSummary).toBeDefined();
    });
  });

  describe('attestation contract', () => {
    describe('HAPPY (attestation)', () => {
      it('H1: content-aware /review without bound structured evidence returns CONTENT_ANALYSIS_REQUIRED with requiredReviewAttestation', async () => {
        await hydrateAndGetReady();

        const raw = await review.execute({ prNumber: 42, inputOrigin: 'pr' }, ctx);
        const result = parseToolResult(raw);

        expect(result.error).toBeUndefined();
        expect(result.status).toBe('pending_review');
        expect(result.code).toBe('CONTENT_ANALYSIS_REQUIRED');
        expect(result.requiredReviewAttestation).toBeDefined();
        const attestation = requiredRecord(result.requiredReviewAttestation, 'review attestation');
        expect(attestation.reviewedBy).toBe('flowguard-reviewer');
        expect(attestation.mandateDigest).toBe(REVIEW_MANDATE_DIGEST);
        expect(attestation.criteriaVersion).toBe(REVIEW_CRITERIA_VERSION);
        // toolObligationId is always present — every content-aware /review
        // creates a real ReviewObligation with a canonical UUID.
        expect(attestation.toolObligationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(result.reviewAttemptId).toMatch(/^[0-9a-f-]{36}$/);
        expect(result.reviewObligation).toMatchObject({
          obligationId: attestation.toolObligationId,
          obligationType: 'review',
        });
        expect(result.reviewerSubagentType).toBe('flowguard-reviewer');
        expect(Array.isArray(result.recovery)).toBe(true);
        if (!Array.isArray(result.recovery)) throw new TypeError('Expected recovery array');
        expect(result.recovery.length).toBeGreaterThan(0);
      });

      it('H2: host-bound structured evidence with obligation-bound toolObligationId is accepted, mapped, and skips external content reload', async () => {
        // Full flow: create obligation -> submit findings with matching UUID -> success.
        const refs = [{ ref: 'https://github.com/owner/repo/pull/77', type: 'pr' as const }];
        const result = await submitContentReview(
          { prNumber: 77, inputOrigin: 'pr', references: refs },
          'changes_requested',
        );

        expect(result.error).toBeUndefined();
        expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
        const mapped = result.findings as Array<Record<string, unknown>>;
        expect(
          hasMaterialFinding(
            mapped,
            'Critical security flaw in authentication flow',
            'risk',
            'error',
          ),
        ).toBe(true);
        expect(result.reviewSubject).toMatchObject({
          kind: 'repository_change',
          source: { kind: 'pull_request', pullRequestNumber: 77 },
        });
      });

      it('H3: plain /review without content fields still works (no structured evidence needed)', async () => {
        await hydrateAndGetReady();

        const raw = await review.execute({}, ctx);
        const result = parseToolResult(raw);

        expect(result.error).toBeUndefined();
        expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
        expect(result.requiredReviewAttestation).toBeUndefined();
      });
    });

    describe('BAD (attestation)', () => {
      function expectAttestationBlocked(result: Record<string, unknown>) {
        expect(result.error).toBe(true);
        expect(result.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');
        const att = result.requiredReviewAttestation as Record<string, unknown> | undefined;
        expect(att).toBeDefined();
        expect(att?.reviewedBy).toBe('flowguard-reviewer');
        expect(att?.mandateDigest).toBe(REVIEW_MANDATE_DIGEST);
        expect(att?.criteriaVersion).toBe(REVIEW_CRITERIA_VERSION);
        expect(typeof att?.toolObligationId).toBe('string');
        expect(result.reviewerSubagentType).toBe('flowguard-reviewer');
      }

      it('B1: non-subagent captured findings are rejected before acceptance', async () => {
        const uuid = await obtainObligationUuid({ prNumber: 1, inputOrigin: 'pr' });
        const findings = {
          ...buildAnalysisFindings('accept', uuid),
          reviewMode: 'human',
        } as unknown as Parameters<typeof bindHostTaskReviewEvidence>[1];
        await bindHostTaskReviewEvidence(uuid, findings);
        const raw = await review.execute(
          { prNumber: 1, reviewObligationId: uuid, inputOrigin: 'pr' },
          ctx,
        );
        const result = parseToolResult(raw);
        expect(result.error).toBe(true);
        expect(result.code).toBe('SUBAGENT_EVIDENCE_MISSING');
      });

      it('B2: missing attestation is rejected with requiredReviewAttestation', async () => {
        const uuid = await obtainObligationUuid({ prNumber: 1, inputOrigin: 'pr' });
        const base = buildAnalysisFindings('accept', uuid) as Record<string, unknown>;
        const { attestation: _omit, ...rest } = base;
        void _omit;
        await bindHostTaskReviewEvidence(uuid, rest as never);
        const raw = await review.execute(
          {
            prNumber: 1,
            reviewObligationId: uuid,
            inputOrigin: 'pr',
          },
          ctx,
        );
        expectAttestationBlocked(parseToolResult(raw));
      });

      it('B3: attestation.reviewedBy !== "flowguard-reviewer" is rejected as unparseable evidence', async () => {
        const uuid = await obtainObligationUuid({ prNumber: 1, inputOrigin: 'pr' });
        const base = buildAnalysisFindings('accept', uuid);
        const findings = {
          ...base,
          attestation: { ...base.attestation, reviewedBy: 'someone-else' },
        };
        await bindHostTaskReviewEvidence(uuid, findings);
        const raw = await review.execute(
          { prNumber: 1, reviewObligationId: uuid, inputOrigin: 'pr' },
          ctx,
        );
        const result = parseToolResult(raw);
        // The capture schema pins the reviewer identity: a foreign reviewer
        // cannot even parse into ReviewFindings, so it fails as missing evidence.
        expect(result.error).toBe(true);
        expect(result.code).toBe('SUBAGENT_EVIDENCE_MISSING');
      });

      it('B4: attestation.mandateDigest mismatch is rejected', async () => {
        const uuid = await obtainObligationUuid({ prNumber: 1, inputOrigin: 'pr' });
        const base = buildAnalysisFindings('accept', uuid);
        const findings = {
          ...base,
          attestation: { ...base.attestation, mandateDigest: 'wrong-digest-value' },
        };
        await bindHostTaskReviewEvidence(uuid, findings);
        const raw = await review.execute(
          { prNumber: 1, reviewObligationId: uuid, inputOrigin: 'pr' },
          ctx,
        );
        expectAttestationBlocked(parseToolResult(raw));
      });

      it('B5: attestation.criteriaVersion mismatch is rejected', async () => {
        const uuid = await obtainObligationUuid({ prNumber: 1, inputOrigin: 'pr' });
        const base = buildAnalysisFindings('accept', uuid);
        const findings = {
          ...base,
          attestation: { ...base.attestation, criteriaVersion: 'p99-bogus' },
        };
        await bindHostTaskReviewEvidence(uuid, findings);
        const raw = await review.execute(
          { prNumber: 1, reviewObligationId: uuid, inputOrigin: 'pr' },
          ctx,
        );
        expectAttestationBlocked(parseToolResult(raw));
      });

      it('B6: consumed obligation (same toolObligationId after success) is rejected — single-use enforced', async () => {
        // Step 1: Obtain an obligation UUID, bind host evidence, consume it.
        const uuid = await obtainObligationUuid({ prNumber: 42, inputOrigin: 'pr' });
        await bindHostTaskReviewEvidence(uuid, buildAnalysisFindings('accept', uuid));
        const raw1 = await review.execute(
          { prNumber: 42, reviewObligationId: uuid, inputOrigin: 'pr' },
          ctx,
        );
        const result1 = parseToolResult(raw1);
        expect(result1.error).toBeUndefined();
        expect(result1.phase).toBe('PEER_REVIEW_COMPLETE');

        // Step 2: Re-submit the SAME (now consumed) UUID.
        // The obligation was consumed on success — this must be rejected.
        const raw2 = await review.execute(
          { prNumber: 42, reviewObligationId: uuid, inputOrigin: 'pr' },
          ctx,
        );
        const result2 = parseToolResult(raw2);
        expect(result2.error).toBe(true);
        // COMMAND_NOT_ALLOWED: the session advanced to REVIEW_COMPLETE after
        // the obligation was consumed, so /review is no longer permitted.
        // This proves the obligation lifecycle completed successfully.
        expect(result2.code).toBe('COMMAND_NOT_ALLOWED');
      });
    });

    describe('CORNER (attestation)', () => {
      it('C1: all five finding arrays surface in the report with schema-allowed categories', async () => {
        await hydrateAndGetReady();
        const uuid = await obtainObligationUuid({
          text: 'diff content',
          inputOrigin: 'manual_text',
        });
        const base = buildAnalysisFindings('changes_requested', uuid);
        const findings = {
          ...base,
          blockingIssues: [
            {
              severity: 'critical' as const,
              category: 'correctness' as const,
              message: 'Logic error in token refresh',
              relation: REVIEW_RELATION,
            },
          ],
          majorRisks: [
            {
              severity: 'major' as const,
              category: 'risk' as const,
              message: 'Race condition in cache invalidation',
              relation: REVIEW_RELATION,
            },
          ],
          missingVerification: ['no integration test for the new error path'],
          scopeCreep: ['unrelated dependency upgrade snuck in'],
          unknowns: ['behaviour under sustained load is unproven'],
        };

        await bindHostTaskReviewEvidence(uuid, findings as never);
        const raw = await review.execute(
          { text: 'diff content', reviewObligationId: uuid, inputOrigin: 'manual_text' },
          ctx,
        );
        const result = parseToolResult(raw);
        expect(result.error).toBeUndefined();

        const mapped = result.findings as Array<Record<string, unknown>>;
        expect(hasMaterialFinding(mapped, 'Logic error in token refresh')).toBe(true);
        expect(hasMaterialFinding(mapped, 'Race condition in cache invalidation')).toBe(true);
        expect(
          mapped.some(
            (f) =>
              f.category === 'missing-verification' &&
              f.message === 'no integration test for the new error path',
          ),
        ).toBe(true);
        expect(
          mapped.some(
            (f) =>
              f.category === 'scope-creep' && f.message === 'unrelated dependency upgrade snuck in',
          ),
        ).toBe(true);
        expect(
          mapped.some(
            (f) =>
              f.category === 'unknown' &&
              f.message === 'behaviour under sustained load is unproven',
          ),
        ).toBe(true);
      });

      it('C2: empty finding arrays (subagent found no issues) are accepted', async () => {
        const result = await submitContentReview({ prNumber: 99, inputOrigin: 'pr' }, 'accept');
        expect(result.error).toBeUndefined();
        expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
      });
    });

    describe('EDGE (attestation)', () => {
      it('E1: ReviewAttestation schema requires toolObligationId (obligation-bound)', () => {
        const parsed = ReviewAttestation.safeParse({
          mandateDigest: REVIEW_MANDATE_DIGEST,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          iteration: 1,
          planVersion: 1,
          reviewedBy: 'flowguard-reviewer',
          // toolObligationId intentionally omitted — should fail
        });
        expect(parsed.success).toBe(false);
      });

      it('E2: runtime gate (validateStrictAttestation) still rejects findings without toolObligationId for /plan and /implement', async () => {
        // Schema is permissive (E1) — but runtime obligation gate must remain strict.
        // validateStrictAttestation compares attestation.toolObligationId against
        // expected.obligationId; undefined !== <real-uuid> -> SUBAGENT_MANDATE_MISMATCH.
        const { validateStrictAttestation } = await import('./review/obligations/assurance.js');
        const findings = {
          iteration: 1,
          planVersion: 1,
          reviewMode: 'subagent' as const,
          overallVerdict: 'accept' as const,
          blockingIssues: [],
          majorRisks: [],
          missingVerification: [],
          scopeCreep: [],
          unknowns: [],
          challenges: [],
          reviewedBy: { sessionId: 'flowguard-reviewer-session-xyz' },
          reviewedAt: '2026-01-01T00:00:00.000Z',
          attestation: {
            mandateDigest: REVIEW_MANDATE_DIGEST,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            iteration: 1,
            planVersion: 1,
            reviewedBy: 'flowguard-reviewer' as const,
            toolObligationId: '00000000-0000-0000-0000-000000000000',
          },
        };
        const expected = {
          obligationId: '11111111-2222-3333-8444-555555555555',
          iteration: 1,
          planVersion: 1,
        };
        const verdict = validateStrictAttestation(findings, expected);
        expect(verdict).toBe('SUBAGENT_MANDATE_MISMATCH');
      });
    });

    describe('E2E (attestation)', () => {
      it('EE1: hydrate -> blocked with attestation -> consume payload -> succeed with complete ReviewFindings', async () => {
        await hydrateAndGetReady();

        // Step 1: call /review with content but no bound structured evidence -> blocked
        const refs = [{ ref: 'https://github.com/owner/repo/pull/42', type: 'pr' as const }];
        const blockedRaw = await review.execute(
          { prNumber: 42, inputOrigin: 'pr', references: refs, targetPaths: ['docs/test.md'] },
          ctx,
        );
        const blocked = parseToolResult(blockedRaw);
        expect(blocked.code).toBe('CONTENT_ANALYSIS_REQUIRED');
        expect(blocked.requiredReviewAttestation).toBeDefined();

        const att = blocked.requiredReviewAttestation as Record<string, string>;
        const obligationId = requiredString(att, 'toolObligationId');
        const reviewedBy = requiredString(att, 'reviewedBy') as 'flowguard-reviewer';
        const mandateDigest = requiredString(att, 'mandateDigest');
        const criteriaVersion = requiredString(att, 'criteriaVersion');

        // Step 2: build ReviewFindings from the canonical attestation values returned
        const findings = {
          iteration: 1,
          planVersion: 1,
          reviewMode: 'subagent' as const,
          overallVerdict: 'accept' as const,
          blockingIssues: [],
          majorRisks: [],
          missingVerification: [],
          scopeCreep: [],
          unknowns: [],
          challenges: [],
          reviewedBy: { sessionId: 'flowguard-reviewer-session-e2e' },
          reviewedAt: '2026-01-01T00:00:00.000Z',
          attestation: {
            iteration: 1,
            planVersion: 1,
            reviewedBy,
            mandateDigest,
            criteriaVersion,
            toolObligationId: obligationId,
          },
        };

        // Step 3: host-capture the reviewer's structured findings against the
        // obligation, then re-call /review verdict-only.
        await bindHostTaskReviewEvidence(obligationId, findings);
        const raw = await review.execute(
          {
            prNumber: 42,
            reviewObligationId: obligationId,
            inputOrigin: 'pr',
            references: refs,
          },
          ctx,
        );
        const result = parseToolResult(raw);
        expect(result.error).toBeUndefined();
        expect(result.phase).toBe('PEER_REVIEW_COMPLETE');
        expect(result.reviewSubject).toMatchObject({
          kind: 'repository_change',
          source: { kind: 'pull_request', pullRequestNumber: 42 },
        });
      });
    });

    describe('SMOKE (attestation)', () => {
      it('S1: requiredReviewAttestation.mandateDigest is the canonical REVIEW_MANDATE_DIGEST constant', async () => {
        await hydrateAndGetReady();
        const raw = await review.execute({ prNumber: 1, inputOrigin: 'pr' }, ctx);
        const result = parseToolResult(raw);
        const attestation = requiredRecord(result.requiredReviewAttestation, 'review attestation');
        expect(attestation.mandateDigest).toBe(REVIEW_MANDATE_DIGEST);
        expect(attestation.mandateDigest).toMatch(/^[a-f0-9]{64}$/);
      });

      it('S2: CONTENT_ANALYSIS_REQUIRED and SUBAGENT_REVIEW_NOT_INVOKED return identical attestation payload', async () => {
        await hydrateAndGetReady();

        // CONTENT_ANALYSIS_REQUIRED: triggered by content fields without bound evidence.
        const rawA = await review.execute(
          { prNumber: 7, inputOrigin: 'pr', targetPaths: ['docs/test.md'] },
          ctx,
        );
        const a = parseToolResult(rawA);
        expect(a.code).toBe('CONTENT_ANALYSIS_REQUIRED');
        const uuid = requiredString(a.requiredReviewAttestation, 'toolObligationId');

        // SUBAGENT_REVIEW_NOT_INVOKED: captured evidence missing its attestation.
        const base = buildAnalysisFindings('accept', uuid) as Record<string, unknown>;
        const { attestation: _omit, ...rest } = base;
        void _omit;
        await bindHostTaskReviewEvidence(uuid, rest as never);
        const rawB = await review.execute(
          { prNumber: 7, reviewObligationId: uuid, inputOrigin: 'pr' },
          ctx,
        );
        const b = parseToolResult(rawB);
        expect(b.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');

        expect(a.requiredReviewAttestation).toEqual(b.requiredReviewAttestation);
        expect(a.reviewerSubagentType).toBe(b.reviewerSubagentType);
      });
    });

    describe('INVOCATION EVIDENCE', () => {
      it('H4: successful /review consumes the host-bound ReviewInvocationEvidence', async () => {
        const uuid = await obtainObligationUuid({ prNumber: 42, inputOrigin: 'pr' });
        const findings = buildAnalysisFindings('accept', uuid);
        await bindHostTaskReviewEvidence(uuid, findings);
        const raw = await review.execute(
          { prNumber: 42, reviewObligationId: uuid, inputOrigin: 'pr' },
          ctx,
        );
        const result = parseToolResult(raw);
        expect(result.error).toBeUndefined();

        // Read state and verify the host-bound invocation evidence.
        const { computeFingerprint, sessionDir: resolveSessionDir } =
          await import('../adapters/workspace/index.js');
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
        const state = await readState(sessDir);
        if (!state) throw new TypeError('Expected persisted session state');
        const invocations = state.reviewAssurance?.invocations ?? [];
        expect(invocations.length).toBe(1);
        const invocation = invocations[0];
        if (!invocation) throw new TypeError('Expected invocation evidence');
        expect(invocation.agentType).toBe('flowguard-reviewer');
        expect(invocation.obligationType).toBe('review');
        expect(invocation.obligationId).toBe(uuid);
        expect(invocation.source).toBe('host-orchestrated');
        expect(invocation.reviewOutputMode).toBe('structured_output');
        expect(invocation.findingsHash).toMatch(/^[a-f0-9]{64}$/);
        expect(invocation.promptHash).toBe('a'.repeat(64));
        // childSessionId from the attested reviewedBy.sessionId in buildAnalysisFindings.
        expect(invocation.childSessionId).toBe('flowguard-reviewer-session-123');
        expect(invocation.consumedByObligationId).toBe(uuid);
      });

      it('H4b: submit path fails closed with SUBAGENT_REVIEW_NOT_INVOKED on unable_to_review verdict', async () => {
        // Item 1 defense-in-depth: even if a reviewer returns a well-attested
        // findings object whose verdict is the third LoopVerdict, the standalone
        // /review submit path MUST reject it and MUST NOT record passing evidence.
        const uuid = await obtainObligationUuid({ prNumber: 91, inputOrigin: 'pr' });
        const findings = {
          ...buildAnalysisFindings('accept', uuid),
          overallVerdict: 'unable_to_review',
        };
        await bindHostTaskReviewEvidence(uuid, findings as never);
        const raw = await review.execute(
          { prNumber: 91, reviewObligationId: uuid, inputOrigin: 'pr' },
          ctx,
        );
        const result = parseToolResult(raw);
        expect(result.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');

        const { computeFingerprint, sessionDir: resolveSessionDir } =
          await import('../adapters/workspace/index.js');
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
        const state = await readState(sessDir);
        if (!state) throw new TypeError('Expected persisted session state');
        // The capture itself is retained for audit, but it must not be consumed
        // and no passing findings may be recorded.
        const obligation = state.reviewAssurance?.obligations.find((o) => o.obligationId === uuid);
        expect(obligation?.status).not.toBe('consumed');
        expect(state.peerReviewFindings ?? []).toHaveLength(0);
      });

      it('H5: obligation is consumed after successful /review', async () => {
        const uuid = await obtainObligationUuid({ prNumber: 43, inputOrigin: 'pr' });
        const findings = buildAnalysisFindings('accept', uuid);
        await bindHostTaskReviewEvidence(uuid, findings);
        const raw = await review.execute(
          { prNumber: 43, reviewObligationId: uuid, inputOrigin: 'pr' },
          ctx,
        );
        const result = parseToolResult(raw);
        expect(result.error).toBeUndefined();

        const { computeFingerprint, sessionDir: resolveSessionDir } =
          await import('../adapters/workspace/index.js');
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
        const state = await readState(sessDir);
        if (!state) throw new TypeError('Expected persisted session state');
        const consumed = state.reviewAssurance?.obligations.find(
          (o) => o.obligationType === 'review' && o.obligationId === uuid,
        );
        expect(consumed).toBeDefined();
        expect(consumed?.status).toBe('consumed');
        expect(consumed?.consumedAt).toBeTruthy();
        // invocationId was set by fulfillObligation before consumption.
        expect(consumed?.invocationId).toMatch(/^[0-9a-f-]{36}$/);
      });

      it('E3: consumeReviewObligation accepts fulfilled obligation (fulfilled -> consumed transition)', async () => {
        const { consumeReviewObligation, ensureReviewAssurance } =
          await import('./review/obligations/assurance.js');
        const assurance = ensureReviewAssurance(undefined);
        const obligation = {
          obligationId: '00000000-0000-0000-0000-000000000001',
          obligationType: 'review' as const,
          requiredChallengeCount: 0,
          requiredChallengeKind: 'content_challenge' as const,
          challengePolicyVersion: 'challenge-policy.v1' as const,
          subjectDigest: 'test-subject-digest',
          iteration: 1,
          reviewCycle: null,
          planVersion: 1,
          criteriaVersion: REVIEW_CRITERIA_VERSION,
          mandateDigest: REVIEW_MANDATE_DIGEST,
          maxReviewerAttempts: 1,
          reviewProfile: 'core' as const,
          profileSource: 'policy_default' as const,
          reviewMaterial: {
            content: 'frozen review material',
            materialDigest: 'a'.repeat(64),
            subjectDigest: 'test-subject-digest',
          },
          createdAt: new Date().toISOString(),
          pluginHandshakeAt: null,
          status: 'fulfilled' as const,
          invocationId: '00000000-0000-0000-0000-000000000002',
          blockedCode: null,
          fulfilledAt: new Date().toISOString(),
          consumedAt: null,
          reviewSubjectScope: {
            kind: 'repository_change' as const,
            paths: ['src/foo.ts'],
            revisions: ['base', 'head'] as const,
          },
        };
        const withObligation = {
          ...assurance,
          obligations: [...assurance.obligations, obligation],
        };
        const consumed = consumeReviewObligation(
          ensureReviewAssurance(withObligation),
          obligation,
          new Date().toISOString(),
        );
        const found = consumed.obligations.find((o) => o.obligationId === obligation.obligationId);
        expect(found?.status).toBe('consumed');
        expect(found?.consumedAt).toBeTruthy();
      });

      it('EE2: full flow end-to-end with invocation evidence', async () => {
        const result = await submitContentReview({ prNumber: 48, inputOrigin: 'pr' }, 'accept');
        expect(result.error).toBeUndefined();

        const { computeFingerprint, sessionDir: resolveSessionDir } =
          await import('../adapters/workspace/index.js');
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
        const state = await readState(sessDir);
        if (!state) throw new TypeError('Expected persisted session state');
        const inv = state.reviewAssurance?.invocations ?? [];
        const obl = state.reviewAssurance?.obligations ?? [];
        expect(inv.length).toBeGreaterThanOrEqual(1);
        expect(obl.length).toBeGreaterThanOrEqual(1);
        const reviewObls = obl.filter((o) => o.obligationType === 'review');
        expect(reviewObls.some((o) => o.status === 'consumed')).toBe(true);
        const reviewInvs = inv.filter((i) => i.obligationType === 'review');
        expect(reviewInvs.length).toBeGreaterThanOrEqual(1);
      });

      it('S3: ReviewInvocationEvidence.parse accepts buildInvocationEvidence output', async () => {
        const { buildInvocationEvidence } = await import('./review/obligations/assurance.js');
        const inv = buildInvocationEvidence({
          obligationId: '11111111-2222-3333-8444-555555555555',
          obligationType: 'review',
          mandateDigest: 'fixture-mandate-digest',
          criteriaVersion: 'fixture-criteria-v1',
          parentSessionId: 'parent-session',
          childSessionId: 'child-session',
          promptHash: 'a'.repeat(64),
          findingsHash: 'b'.repeat(64),
          invokedAt: new Date().toISOString(),
          fulfilledAt: new Date().toISOString(),
          capturedRawFindings: { overallVerdict: 'accept' },
          attemptId: '11111111-2222-4333-8444-555555555555',
        });
        expect(ReviewInvocationEvidence.safeParse(inv).success).toBe(true);
      });

      it('reviewCard is present in successful /review response', async () => {
        const result = await submitContentReview({ prNumber: 49, inputOrigin: 'pr' }, 'accept');
        expect(result.error).toBeUndefined();
        expect(result.reviewCard).toBeDefined();
        expect(typeof result.reviewCard).toBe('string');
        const card = result.reviewCard as string;
        expect(card).toContain('# FlowGuard Review Report');
        expect(card).toContain('Peer review complete');
        expect(result.presentation).toEqual({ markdown: card });

        const { computeFingerprint, sessionDir: resolveSessionDir } =
          await import('../adapters/workspace/index.js');
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
        const artifactsDir = `${sessDir}/artifacts`;
        const files = await fs.readdir(artifactsDir);
        const cardFile = files.find(
          (f) => f.startsWith('review-report-card.') && f.endsWith('.md'),
        );
        expect(cardFile).toBeDefined();
        const content = await fs.readFile(`${artifactsDir}/${cardFile}`, 'utf-8');
        expect(content).toContain('# FlowGuard Review Report');

        const reportRaw = await fs.readFile(`${sessDir}/review-report.json`, 'utf-8');
        const report = JSON.parse(reportRaw) as Record<string, unknown>;
        expect(report.phase).toBe('PEER_REVIEW_COMPLETE');
        expect(report.completeness).toBeUndefined();
        const persistedCoverage = report.peerReviewCoverage as Record<string, unknown>;
        expect(persistedCoverage).toEqual(result.peerReviewCoverage);
        expect(persistedCoverage).toEqual({
          targetResolved: true,
          targetFrozen: true,
          repositoryIdentityVerified: true,
          baseSha: 'b'.repeat(40),
          headSha: 'a'.repeat(40),
          changedPathCount: 3,
          objectivesCovered: 3,
          objectivesTotal: 3,
          reviewAssurance: 'structured_high',
          missingVerification: [],
        });
      });
    });
  });

  describe('content source completeness', () => {
    it('BYPASS-1: inputOrigin=branch + references WITHOUT branch field is blocked', async () => {
      await hydrateAndGetReady();

      const result = await review.execute(
        {
          inputOrigin: 'branch',
          references: [
            {
              ref: 'feature/add-due-date',
              type: 'branch',
              title: 'Add dueDate field',
              source: 'local',
            },
          ],
        },
        ctx,
      );
      expect(typeof result).toBe('string');
      const parsed = parseToolResult(result);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('REVIEW_CONTENT_SOURCE_INCOMPLETE');
      expect(parsed.message).toContain('inputOrigin=branch');
    });

    it('BYPASS-2: content-free call WITHOUT inputOrigin/references still completes mechanically', async () => {
      await hydrateAndGetReady();

      const result = await review.execute({}, ctx);
      expect(typeof result).toBe('string');
      const parsed = parseToolResult(result);
      expect(parsed.error).toBeUndefined();
      expect(parsed.phase).toBe('PEER_REVIEW_COMPLETE');
    });

    it('BYPASS-3: inputOrigin=branch WITH branch field triggers content-aware flow', async () => {
      await hydrateAndGetReady();

      const result = await review.execute(
        { inputOrigin: 'branch', branch: 'feature/some-branch' },
        ctx,
      );
      expect(typeof result).toBe('string');
      const parsed = parseToolResult(result);
      // With an actual branch field, the review is content-aware.
      // It may fail on GIT_NOT_FOUND or return CONTENT_ANALYSIS_REQUIRED,
      // but it MUST NOT be REVIEW_CONTENT_SOURCE_INCOMPLETE.
      expect(parsed.code).not.toBe('REVIEW_CONTENT_SOURCE_INCOMPLETE');
    });

    it('BYPASS-4: empty text field ("") is blocked as incomplete source', async () => {
      await hydrateAndGetReady();

      const result = await review.execute({ text: '' }, ctx);
      expect(typeof result).toBe('string');
      const parsed = parseToolResult(result);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('REVIEW_CONTENT_SOURCE_INCOMPLETE');
    });

    it('BYPASS-5: whitespace-only text field is blocked as incomplete source', async () => {
      await hydrateAndGetReady();

      const result = await review.execute({ text: '   ' }, ctx);
      expect(typeof result).toBe('string');
      const parsed = parseToolResult(result);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('REVIEW_CONTENT_SOURCE_INCOMPLETE');
    });

    it('BYPASS-6: empty branch field ("") is blocked (fail-closed)', async () => {
      await hydrateAndGetReady();

      const result = await review.execute({ inputOrigin: 'branch', branch: '' }, ctx);
      expect(typeof result).toBe('string');
      const parsed = parseToolResult(result);
      // An empty branch field hits either the source validator
      // (REVIEW_CONTENT_SOURCE_INCOMPLETE) or the branch-content loader
      // (REVIEW_BRANCH_PROVENANCE_MISSING).  Both are fail-closed.
      expect(parsed.error).toBe(true);
      const validCodes = new Set([
        'REVIEW_CONTENT_SOURCE_INCOMPLETE',
        'REVIEW_BRANCH_PROVENANCE_MISSING',
      ]);
      expect(validCodes.has(String(parsed.code ?? ''))).toBe(true);
    });
  });
});
