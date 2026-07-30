import * as path from 'node:path';
/**
 * @module integration/tools-execute.test
 * @description Execution tests for FlowGuard tool execute() functions.
 *
 * Tests each tool's execute() against real filesystem persistence with
 * OPENCODE_CONFIG_DIR redirected to a temp directory. Git adapter functions
 * (remoteOriginUrl, changedFiles, listRepoSignals) are selectively mocked;
 * all other I/O (workspace init, state read/write, config) runs for real.
 *
 * Scope: Tool behavior, tool-to-state, tool-to-persistence, tool-specific edge cases.
 * NOT in scope: Full multi-step workflows (see e2e-workflow.test.ts).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import {
  createToolContext,
  createTestWorkspace,
  isTarAvailable,
  parseToolResult,
  isBlockedResult,
  fulfillStrictReviewObligation,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
  withTestEnv,
} from './test-helpers.js';
import { REVIEW_MANDATE_DIGEST, REVIEW_CRITERIA_VERSION } from './review/assurance.js';
import { ReviewAttestation, ReviewInvocationEvidence } from '../state/evidence.js';
import { findLatestPendingReviewObligation } from './review/assurance.js';
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
import { readAuditTrail } from '../adapters/persistence-audit.js';
import * as persistence from '../adapters/persistence.js';
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
import { resolvePolicyFromState, writeStateWithArtifacts } from './tools/helpers.js';
import { TEAM_POLICY } from '../config/policy.js';
import {
  clearUserDecisionIntents,
  peekUserDecisionIntent,
  recordUserDecisionIntent,
  recordUserDecisionIntentFromCommand,
} from './user-decision-intent.js';
import type { ReviewVerdict } from '../state/evidence.js';

// ─── Git Mock ────────────────────────────────────────────────────────────────

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

// ─── Workspace Mock (P26) ────────────────────────────────────────────────────
// Partial mock: archiveSession and verifyArchive are vi.fn() wrappers that
// default to the real implementations. P26 tests override them per-test.
// All other workspace exports (computeFingerprint, initWorkspace, etc.)
// remain real for full integration fidelity.
//
// Originals are stored via vi.hoisted (survives vi.mock hoisting) so afterEach
// can fully reset the once-queues (vi.clearAllMocks does NOT clear
// mockResolvedValueOnce queues — unconsumed values leak across tests).

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

// ─── Actor Mock (P27) ────────────────────────────────────────────────────────
// Mock resolveActor to return a deterministic actor for integration tests.
// Prevents dependency on real env vars or git config.

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
    }),
  };
});

// Lazy import for per-test overrides
const gitMock = await import('../adapters/git.js');
const wsMock = await import('../adapters/workspace/index.js');
const actorMock = await import('../adapters/actor.js');

// ─── GH-CLI Mock ────────────────────────────────────────────────────────────
// Mock gh-cli adapter to avoid dependency on real `gh` CLI in tests.
// Using vi.mock() which is hoisted, so this affects all tests.
// The P34a test doesn't use gh-cli, so this is safe.

vi.mock('../adapters/gh-cli', () => ({
  hasGhCli: vi.fn().mockReturnValue(true),
  loadPrDiff: vi.fn().mockReturnValue('diff --git a/src/file.ts b/src/file.ts\n+new line'),
  loadBranchDiff: vi.fn().mockReturnValue('diff --git a/src/file.ts b/src/file.ts\n+branch line'),
  resolveBranchReviewSource: vi.fn().mockImplementation((branch: string) => ({
    branch,
    baseBranch: 'main',
    resolvedBranchSha: 'a'.repeat(40),
    resolvedBaseSha: 'b'.repeat(40),
  })),
  loadResolvedBranchDiff: vi
    .fn()
    .mockReturnValue('diff --git a/src/file.ts b/src/file.ts\n+resolved line'),
}));

// ─── Capability Gates ────────────────────────────────────────────────────────

const tarOk = await isTarAvailable();

// ─── Test Setup ──────────────────────────────────────────────────────────────

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
  // Reset workspace mock once-queues to prevent cross-test leaks.
  // vi.clearAllMocks() only clears calls/results, NOT mockResolvedValueOnce
  // queues. If a P26 test fails before consuming its once-mocks, the stale
  // values leak into subsequent tests (e.g. archive manifest test).
  vi.mocked(wsMock.archiveSession).mockReset().mockImplementation(wsOriginals.archiveSession);
  vi.mocked(wsMock.verifyArchive).mockReset().mockImplementation(wsOriginals.verifyArchive);
  // Reset actor mock to default deterministic value (P27/P34)
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
  clearUserDecisionIntents();
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Hydrate a session and return parsed result. Convenience for setup. */
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

/** Hydrate + ticket. Convenience for tests that need to start from PLAN phase. */
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

function recordUserDecision(verdict: ReviewVerdict): void {
  const command =
    verdict === 'approve'
      ? '/approve'
      : verdict === 'changes_requested'
        ? '/request-changes'
        : '/reject';
  recordUserDecisionIntent({
    sessionId: ctx.sessionID,
    command,
    expectedVerdict: verdict,
  });
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

describe('P34a: Agent-Orchestrated Review', () => {
  const validReviewFindingsSubagent = {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent' as const,
    overallVerdict: 'accept' as const,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_test' },
    reviewedAt: new Date().toISOString(),
  };

  const validReviewFindingsSelf = {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'self' as unknown as 'subagent',
    overallVerdict: 'accept' as const,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_self' },
    reviewedAt: new Date().toISOString(),
  };

  it('reviewMode=subagent accepted by mandatory default', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'accept');
    const raw = await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);
    const result = parseToolResult(raw);
    expect(result.error).toBeUndefined();
    expect(result.selfReviewIteration).toBe(1);
  });

  it('reviewMode=self blocked by mandatory default in Mode B', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    const raw = await plan.execute(
      { reviewVerdict: 'accept', reviewFindings: validReviewFindingsSelf },
      ctx,
    );
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
  });

  it('planVersion mismatch blocked in Mode B', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    const wrongVersion = { ...validReviewFindingsSubagent, planVersion: 99 };
    const raw = await plan.execute(
      { reviewVerdict: 'changes_requested', reviewFindings: wrongVersion },
      ctx,
    );
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
  });

  it('iteration mismatch blocked in Mode B', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    const wrongIteration = { ...validReviewFindingsSubagent, iteration: 99 };
    const raw = await plan.execute(
      { reviewVerdict: 'changes_requested', reviewFindings: wrongIteration },
      ctx,
    );
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('REVIEW_ITERATION_MISMATCH');
  });

  it('persists reviewFindings in state.plan.reviewFindings', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'accept');
    await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);

    const { computeFingerprint, sessionDir: resolveSessionDir } =
      await import('../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
    const state = await readState(sessDir);

    expect(state).not.toBeNull();
    if (!state?.plan) throw new TypeError('Expected persisted plan state');
    expect(state.plan.reviewFindings).toHaveLength(1);
    expect(state.plan.reviewFindings?.[0]?.reviewMode).toBe('subagent');
    expect(state.plan.history).toHaveLength(0);
  });

  it('persists plan in state.plan.current (separate from reviewFindings)', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'accept');
    await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);

    const { computeFingerprint, sessionDir: resolveSessionDir } =
      await import('../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
    const state = await readState(sessDir);

    expect(state).not.toBeNull();
    if (!state?.plan) throw new TypeError('Expected persisted plan state');
    expect(state.plan.current).toBeDefined();
    expect(state.plan.current.body).toContain('## Plan');
    expect(state.plan.reviewFindings?.[0]?.reviewedBy.sessionId).toBe('ses_plan_reviewer');
    expect(state.plan.history).toHaveLength(0);
  });

  it('accepts valid reviewFindings with planVersion=1 in Mode B', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'accept');
    const raw = await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);
    const result = parseToolResult(raw);
    expect(result.error).toBeUndefined();
    expect(result.selfReviewIteration).toBe(1);
  });

  it('converged Mode B response appears after reviewFindings submission', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'accept');
    const raw = await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);
    const result = parseToolResult(raw);

    expect(result.error).toBeUndefined();
    expect(result.status).toContain('Independent review converged');
    expect(result.selfReviewIteration).toBe(1);
  });
});

describe('P34a: Policy-Driven Branches', () => {
  const validReviewFindingsSubagent = {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent' as const,
    overallVerdict: 'accept' as const,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_subagent' },
    reviewedAt: new Date().toISOString(),
  };

  const validReviewFindingsSubagentModeB = {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent' as const,
    overallVerdict: 'accept' as const,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_subagent' },
    reviewedAt: new Date().toISOString(),
  };

  const validReviewFindingsSelf = {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'self' as unknown as 'subagent',
    overallVerdict: 'accept' as const,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_self' },
    reviewedAt: new Date().toISOString(),
  };

  it('subagentEnabled=true + reviewMode=subagent → accepted', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);

    const { computeFingerprint, sessionDir: resolveSessionDir } =
      await import('../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);

    const state = await readState(sessDir);
    await writeState(sessDir, {
      ...state!,
      policySnapshot: {
        ...state!.policySnapshot,
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      },
    });

    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'accept');
    const raw = await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);
    const result = parseToolResult(raw);
    expect(result.error).toBeUndefined();
    expect(result.selfReviewIteration).toBe(1);
  });

  it('subagentEnabled=true + fallbackToSelf=true + reviewMode=self → BLOCKED', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);

    const { computeFingerprint, sessionDir: resolveSessionDir } =
      await import('../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);

    const state = await readState(sessDir);
    await writeState(sessDir, {
      ...state!,
      policySnapshot: {
        ...state!.policySnapshot,
        selfReview: { subagentEnabled: true, fallbackToSelf: true, strictEnforcement: false },
      },
    });

    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    const raw = await plan.execute(
      { reviewVerdict: 'accept', reviewFindings: validReviewFindingsSelf },
      ctx,
    );
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
  });

  it('subagentEnabled=true + fallbackToSelf=false + reviewMode=self → BLOCKED', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);

    const { computeFingerprint, sessionDir: resolveSessionDir } =
      await import('../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);

    const state = await readState(sessDir);
    await writeState(sessDir, {
      ...state!,
      policySnapshot: {
        ...state!.policySnapshot,
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      },
    });

    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    const raw = await plan.execute(
      { reviewVerdict: 'accept', reviewFindings: validReviewFindingsSelf },
      ctx,
    );
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
  });

  it('approve + subagentEnabled=true + missing reviewFindings → BLOCKED', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);

    const { computeFingerprint, sessionDir: resolveSessionDir } =
      await import('../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);

    const state = await readState(sessDir);
    await writeState(sessDir, {
      ...state!,
      policySnapshot: {
        ...state!.policySnapshot,
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      },
    });

    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    const raw = await plan.execute({ reviewVerdict: 'accept' }, ctx);
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('REVIEW_FINDINGS_REQUIRED');
  });

  it('approve + subagentEnabled=true + valid reviewFindings → accepted', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);

    const { computeFingerprint, sessionDir: resolveSessionDir } =
      await import('../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);

    let state = await readState(sessDir);
    await writeState(sessDir, {
      ...state!,
      policySnapshot: {
        ...state!.policySnapshot,
        selfReview: { subagentEnabled: true, fallbackToSelf: false, strictEnforcement: false },
      },
    });

    state = await readState(sessDir);
    expect(state?.policySnapshot.selfReview?.subagentEnabled).toBe(true);

    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'accept');
    const raw = await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);
    const result = parseToolResult(raw);
    expect(result.error).toBeUndefined();
  });
});

// =============================================================================
// Tool 5: decision (review-decision)
// =============================================================================

describe('decision', () => {
  /** Helper: get to PLAN_REVIEW phase (solo auto-converges self-review). */
  async function reachPlanReview(): Promise<void> {
    await hydrateSession({ policyMode: 'team' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
    // In team mode, submit mandate-bound reviewer findings until convergence.
    for (let i = 0; i < 5; i++) {
      const s = parseToolResult(await status.execute({}, ctx));
      if (s.phase === 'PLAN_REVIEW') break;
      const reviewFindings = await fulfillPlanReview(i, 'accept');
      await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);
    }
  }

  describe('HAPPY', () => {
    it('approve at PLAN_REVIEW advances to VALIDATION', async () => {
      await reachPlanReview();
      recordUserDecision('approve');
      const raw = await decision.execute({ verdict: 'approve', rationale: 'Looks good' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('VALIDATION');
    });
  });

  describe('BAD', () => {
    it('blocks at wrong phase', async () => {
      await hydrateSession();
      const raw = await decision.execute({ verdict: 'approve', rationale: '' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });

    it('blocks without session', async () => {
      const raw = await decision.execute({ verdict: 'approve', rationale: '' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });

    it('fail-closes when derived plan artifacts are missing', async () => {
      await reachPlanReview();
      recordUserDecision('approve');

      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      await fs.rm(`${sessDir}/artifacts`, { recursive: true, force: true });

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Proceed' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('EVIDENCE_ARTIFACT_MISSING');
    });

    it('maps actor claim expiration to structured decision errors', async () => {
      const { ActorClaimError } = actorMock;
      await reachPlanReview();
      recordUserDecision('approve');
      vi.mocked(actorMock.resolveActor).mockRejectedValueOnce(
        new ActorClaimError('ACTOR_CLAIM_EXPIRED', 'claim expired'),
      );

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Proceed' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('ACTOR_CLAIM_EXPIRED');
    });
  });

  describe('CORNER', () => {
    it('blocks model-origin decision in human-gated team mode', async () => {
      await reachPlanReview();
      const raw = await decision.execute({ verdict: 'approve', rationale: 'Looks good' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('HUMAN_DECISION_REQUIRED');
    });

    it('blocks mismatched user-command intent verdict', async () => {
      await reachPlanReview();
      recordUserDecision('approve');
      const raw = await decision.execute(
        { verdict: 'changes_requested', rationale: 'Actually revise' },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('HUMAN_DECISION_REQUIRED');
    });

    it('consumes user-command intent once', async () => {
      await reachPlanReview();
      recordUserDecision('approve');
      const first = parseToolResult(
        await decision.execute({ verdict: 'approve', rationale: 'Looks good' }, ctx),
      );
      expect(first.error).toBeUndefined();

      const state = await readState(await currentSessionDir());
      await writeState(await currentSessionDir(), { ...state!, phase: 'PLAN_REVIEW' });
      const second = parseToolResult(
        await decision.execute({ verdict: 'approve', rationale: 'Replay' }, ctx),
      );
      expect(second.error).toBe(true);
      expect(second.code).toBe('HUMAN_DECISION_REQUIRED');
    });

    it('reject at PLAN_REVIEW returns to TICKET', async () => {
      await reachPlanReview();
      recordUserDecision('reject');
      const raw = await decision.execute({ verdict: 'reject', rationale: 'Need rethink' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('TICKET');
    });

    it('changes_requested at PLAN_REVIEW returns to PLAN', async () => {
      await reachPlanReview();
      recordUserDecision('changes_requested');
      const raw = await decision.execute(
        { verdict: 'changes_requested', rationale: 'More detail needed' },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PLAN');
    });

    it('accepts decision after command.execute.before records a host-command intent', async () => {
      await reachPlanReview();
      // Simulate OpenCode command.execute.before hook firing for /approve.
      // This is the only origin the decision tool trusts in human-gated modes.
      recordUserDecisionIntentFromCommand({
        sessionId: ctx.sessionID,
        command: '/approve',
        arguments: '',
      });
      const raw = await decision.execute(
        { verdict: 'approve', rationale: 'User approved via /approve' },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('VALIDATION');
    });

    it('config verified-actor requirement blocks approve for best_effort reviewer', async () => {
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const { writeRepoConfig, readConfig } = await import('../adapters/persistence-config.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const baseConfig = await readConfig();
      await writeRepoConfig(ws.tmpDir, {
        ...baseConfig,
        policy: {
          ...baseConfig.policy,
          requireVerifiedActorsForApproval: true,
        },
      });

      await reachPlanReview();
      recordUserDecision('approve');
      const raw = await decision.execute({ verdict: 'approve', rationale: 'Looks good' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
    });
  });

  // ── Intent survival across independent pre-persistence failures ──
  // Regression for the double-/approve bug: the user-decision intent must NOT be
  // burned when a decision call fails at a stage AFTER the human-origin gate but
  // BEFORE the decision is persisted (schema validation, actor resolution). The
  // user must be able to retry without re-issuing the /approve command.
  describe('INTENT_SURVIVAL', () => {
    it('preserves intent when actor resolution fails, allowing retry without a new command', async () => {
      const { ActorClaimError } = actorMock;
      await reachPlanReview();
      recordUserDecision('approve');

      // First attempt fails AFTER the human-origin gate (actor resolution throws).
      vi.mocked(actorMock.resolveActor).mockRejectedValueOnce(
        new ActorClaimError('ACTOR_CLAIM_EXPIRED', 'claim expired'),
      );
      const firstRaw = await decision.execute({ verdict: 'approve', rationale: 'Proceed' }, ctx);
      const first = parseToolResult(firstRaw);
      expect(first.error).toBe(true);
      expect(first.code).toBe('ACTOR_CLAIM_EXPIRED');

      // Retry WITHOUT recording a new intent — the original must still be valid.
      const secondRaw = await decision.execute({ verdict: 'approve', rationale: 'Proceed' }, ctx);
      const second = parseToolResult(secondRaw);
      expect(second.error).toBeUndefined();
      expect(second.phase).toBe('VALIDATION');
    });

    it('does not burn the intent when a decision fails before persistence (artifacts missing)', async () => {
      await reachPlanReview();
      recordUserDecision('approve');

      // Remove derived plan artifacts so the decision fails at the
      // artifact/persistence stage rather than completing.
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      await fs.rm(`${sessDir}/artifacts`, { recursive: true, force: true });

      const firstRaw = await decision.execute({ verdict: 'approve', rationale: 'Proceed' }, ctx);
      const first = parseToolResult(firstRaw);
      expect(first.error).toBe(true);
      expect(first.code).toBe('EVIDENCE_ARTIFACT_MISSING');

      // A failed decision must never burn the intent: the intent is only consumed
      // once finalResult.kind === 'ok'. Inspect the store non-destructively.
      expect(
        peekUserDecisionIntent({ sessionId: ctx.sessionID, verdict: 'approve' }),
      ).toMatchObject({ ok: true });
    });

    it('burns intent exactly once on success (no replay after a successful decision)', async () => {
      await reachPlanReview();
      recordUserDecision('approve');

      const first = parseToolResult(
        await decision.execute({ verdict: 'approve', rationale: 'Looks good' }, ctx),
      );
      expect(first.error).toBeUndefined();
      expect(first.phase).toBe('VALIDATION');

      // Force the gate back to PLAN_REVIEW and replay: the consumed intent is gone.
      const state = await readState(await currentSessionDir());
      await writeState(await currentSessionDir(), { ...state!, phase: 'PLAN_REVIEW' });
      const second = parseToolResult(
        await decision.execute({ verdict: 'approve', rationale: 'Replay' }, ctx),
      );
      expect(second.error).toBe(true);
      expect(second.code).toBe('HUMAN_DECISION_REQUIRED');
    });

    it('consumes intent at the correct time for changes_requested (returns to PLAN)', async () => {
      await reachPlanReview();
      recordUserDecision('changes_requested');
      const first = parseToolResult(
        await decision.execute(
          { verdict: 'changes_requested', rationale: 'More detail needed' },
          ctx,
        ),
      );
      expect(first.error).toBeUndefined();
      expect(first.phase).toBe('PLAN');

      // Intent was consumed on success — a replay at PLAN_REVIEW is blocked.
      const state = await readState(await currentSessionDir());
      await writeState(await currentSessionDir(), { ...state!, phase: 'PLAN_REVIEW' });
      const second = parseToolResult(
        await decision.execute({ verdict: 'changes_requested', rationale: 'Replay' }, ctx),
      );
      expect(second.error).toBe(true);
      expect(second.code).toBe('HUMAN_DECISION_REQUIRED');
    });

    it('persists an empty-string rationale when rationale is omitted (null-strip safety)', async () => {
      await reachPlanReview();
      recordUserDecision('approve');
      // Simulate the MCP boundary having stripped a null rationale: the key is absent.
      const raw = await decision.execute({ verdict: 'approve' } as { verdict: ReviewVerdict }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('VALIDATION');
      expect(result.reviewDecision).toMatchObject({ rationale: '' });
    });
  });
});

// =============================================================================
// Tool 10: review (standalone review flow with subagent pattern)
// =============================================================================
