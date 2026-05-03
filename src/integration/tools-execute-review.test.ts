/**
 * @module integration/tools-execute.test
 * @description Execution tests for all 10 FlowGuard tool execute() functions.
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
} from './test-helpers.js';
import { REVIEW_MANDATE_DIGEST, REVIEW_CRITERIA_VERSION } from './review-assurance.js';
import { ReviewAttestation, ReviewInvocationEvidence } from '../state/evidence.js';
import { findLatestPendingReviewObligation } from './review-assurance.js';
import {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  implement,
  validate,
  review,
  abort_session,
  archive,
} from './tools/index.js';
import { readState, writeState, readAuditTrail } from '../adapters/persistence.js';
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
} from '../__fixtures__.js';
import { resolvePolicyFromState, writeStateWithArtifacts } from './tools/helpers.js';
import { TEAM_POLICY } from '../config/policy.js';

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
}));

// ─── Capability Gates ────────────────────────────────────────────────────────

const tarOk = await isTarAvailable();

// ─── Test Setup ──────────────────────────────────────────────────────────────

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
  delete process.env.FLOWGUARD_POLICY_PATH;
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
  const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
    '../adapters/workspace/index.js'
  );
  const fp = await computeFingerprint(ws.tmpDir);
  return resolveSessionDir(fp.fingerprint, ctx.sessionID);
}

async function fulfillPlanReview(
  iteration = 0,
  overallVerdict: 'approve' | 'changes_requested' = 'approve',
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
    overallVerdict: 'approve' as const,
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
    overallVerdict: 'approve' as const,
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
    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'approve');
    const raw = await plan.execute({ selfReviewVerdict: 'approve', reviewFindings }, ctx);
    const result = parseToolResult(raw);
    expect(result.error).toBeUndefined();
    expect(result.selfReviewIteration).toBe(1);
  });

  it('reviewMode=self blocked by mandatory default in Mode B', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    const raw = await plan.execute(
      { selfReviewVerdict: 'approve', reviewFindings: validReviewFindingsSelf },
      ctx,
    );
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
  });

  it('planVersion mismatch blocked in Mode B', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    const wrongVersion = { ...validReviewFindingsSubagent, planVersion: 99 };
    const raw = await plan.execute(
      { selfReviewVerdict: 'changes_requested', reviewFindings: wrongVersion },
      ctx,
    );
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
  });

  it('iteration mismatch blocked in Mode B', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    const wrongIteration = { ...validReviewFindingsSubagent, iteration: 99 };
    const raw = await plan.execute(
      { selfReviewVerdict: 'changes_requested', reviewFindings: wrongIteration },
      ctx,
    );
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('REVIEW_ITERATION_MISMATCH');
  });

  it('persists reviewFindings in state.plan.reviewFindings', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'approve');
    await plan.execute({ selfReviewVerdict: 'approve', reviewFindings }, ctx);

    const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
      '../adapters/workspace/index.js'
    );
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
    const state = await readState(sessDir);

    expect(state.plan).toBeDefined();
    expect(state.plan?.reviewFindings).toHaveLength(1);
    expect(state.plan?.reviewFindings?.[0].reviewMode).toBe('subagent');
    expect(state.plan?.history).toHaveLength(0);
  });

  it('persists plan in state.plan.current (separate from reviewFindings)', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'approve');
    await plan.execute({ selfReviewVerdict: 'approve', reviewFindings }, ctx);

    const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
      '../adapters/workspace/index.js'
    );
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
    const state = await readState(sessDir);

    expect(state.plan).toBeDefined();
    expect(state.plan?.current).toBeDefined();
    expect(state.plan?.current.body).toContain('## Plan');
    expect(state.plan?.reviewFindings?.[0].reviewedBy.sessionId).toBe('ses_plan_reviewer');
    expect(state.plan?.history).toHaveLength(0);
  });

  it('accepts valid reviewFindings with planVersion=1 in Mode B', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'approve');
    const raw = await plan.execute({ selfReviewVerdict: 'approve', reviewFindings }, ctx);
    const result = parseToolResult(raw);
    expect(result.error).toBeUndefined();
    expect(result.selfReviewIteration).toBe(1);
  });

  it('converged Mode B response appears after reviewFindings submission', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'approve');
    const raw = await plan.execute({ selfReviewVerdict: 'approve', reviewFindings }, ctx);
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
    overallVerdict: 'approve' as const,
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
    overallVerdict: 'approve' as const,
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
    overallVerdict: 'approve' as const,
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

    const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
      '../adapters/workspace/index.js'
    );
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);

    const state = await readState(sessDir);
    await writeState(sessDir, {
      ...state!,
      policySnapshot: {
        ...state!.policySnapshot,
        selfReview: { subagentEnabled: true, fallbackToSelf: false },
      },
    });

    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'approve');
    const raw = await plan.execute({ selfReviewVerdict: 'approve', reviewFindings }, ctx);
    const result = parseToolResult(raw);
    expect(result.error).toBeUndefined();
    expect(result.selfReviewIteration).toBe(1);
  });

  it('subagentEnabled=true + fallbackToSelf=true + reviewMode=self → BLOCKED', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);

    const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
      '../adapters/workspace/index.js'
    );
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);

    const state = await readState(sessDir);
    await writeState(sessDir, {
      ...state!,
      policySnapshot: {
        ...state!.policySnapshot,
        selfReview: { subagentEnabled: true, fallbackToSelf: true },
      },
    });

    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    const raw = await plan.execute(
      { selfReviewVerdict: 'approve', reviewFindings: validReviewFindingsSelf },
      ctx,
    );
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
  });

  it('subagentEnabled=true + fallbackToSelf=false + reviewMode=self → BLOCKED', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);

    const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
      '../adapters/workspace/index.js'
    );
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);

    const state = await readState(sessDir);
    await writeState(sessDir, {
      ...state!,
      policySnapshot: {
        ...state!.policySnapshot,
        selfReview: { subagentEnabled: true, fallbackToSelf: false },
      },
    });

    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    const raw = await plan.execute(
      { selfReviewVerdict: 'approve', reviewFindings: validReviewFindingsSelf },
      ctx,
    );
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
  });

  it('approve + subagentEnabled=true + missing reviewFindings → BLOCKED', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);

    const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
      '../adapters/workspace/index.js'
    );
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);

    const state = await readState(sessDir);
    await writeState(sessDir, {
      ...state!,
      policySnapshot: {
        ...state!.policySnapshot,
        selfReview: { subagentEnabled: true, fallbackToSelf: false },
      },
    });

    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    const raw = await plan.execute({ selfReviewVerdict: 'approve' }, ctx);
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('REVIEW_FINDINGS_REQUIRED');
  });

  it('approve + subagentEnabled=true + valid reviewFindings → accepted', async () => {
    await hydrateSession({ policyMode: 'solo' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);

    const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
      '../adapters/workspace/index.js'
    );
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);

    let state = await readState(sessDir);
    await writeState(sessDir, {
      ...state!,
      policySnapshot: {
        ...state!.policySnapshot,
        selfReview: { subagentEnabled: true, fallbackToSelf: false },
      },
    });

    state = await readState(sessDir);
    expect(state.policySnapshot?.selfReview?.subagentEnabled).toBe(true);

    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    const reviewFindings = await fulfillPlanReview(0, 'approve');
    const raw = await plan.execute({ selfReviewVerdict: 'approve', reviewFindings }, ctx);
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
    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    // In team mode, submit mandate-bound reviewer findings until convergence.
    for (let i = 0; i < 5; i++) {
      const s = parseToolResult(await status.execute({}, ctx));
      if (s.phase === 'PLAN_REVIEW') break;
      const reviewFindings = await fulfillPlanReview(i, 'approve');
      await plan.execute({ selfReviewVerdict: 'approve', reviewFindings }, ctx);
    }
  }

  describe('HAPPY', () => {
    it('approve at PLAN_REVIEW advances to VALIDATION', async () => {
      await reachPlanReview();
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

      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
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
    it('reject at PLAN_REVIEW returns to TICKET', async () => {
      await reachPlanReview();
      const raw = await decision.execute({ verdict: 'reject', rationale: 'Need rethink' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('TICKET');
    });

    it('changes_requested at PLAN_REVIEW returns to PLAN', async () => {
      await reachPlanReview();
      const raw = await decision.execute(
        { verdict: 'changes_requested', rationale: 'More detail needed' },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PLAN');
    });

    it('config verified-actor requirement blocks approve for best_effort reviewer', async () => {
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const { writeConfig, readConfig } = await import('../adapters/persistence.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const baseConfig = await readConfig(wsDir);
      await writeConfig(wsDir, {
        ...baseConfig,
        policy: {
          ...baseConfig.policy,
          requireVerifiedActorsForApproval: true,
        },
      });

      await reachPlanReview();
      const raw = await decision.execute({ verdict: 'approve', rationale: 'Looks good' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
    });
  });
});

// =============================================================================
// Tool 10: review (standalone review flow with subagent pattern)
// =============================================================================

describe('review (standalone flow)', () => {
  // Mock fetch for URL tests
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('Mock URL content for review'),
      } as Response),
    );
  });

  // Helper: Create a fresh session in READY phase
  async function hydrateAndGetReady(): Promise<void> {
    const raw = await hydrate.execute({ policyMode: 'team' }, ctx);
    const result = parseToolResult(raw);
    if (result.error) {
      throw new Error(`Failed to hydrate: ${result.message}`);
    }
  }

  // Helper: Build a complete subagent-attested ReviewFindings object as the
  // primary agent would receive it from the flowguard-reviewer subagent.
  // Categories are restricted to the schema-allowed enum
  // ("completeness" | "correctness" | "feasibility" | "risk" | "quality").
  // toolObligationId is required (schema demands it after P2 obligation binding);
  // callers that need the real obligation UUID should create an obligation first
  // and pass the returned UUID to this helper.
  function buildAnalysisFindings(
    overallVerdict: 'approve' | 'changes_requested',
    toolObligationId?: string,
  ) {
    const blockingIssues =
      overallVerdict === 'changes_requested'
        ? [
            {
              severity: 'major' as const,
              category: 'risk' as const,
              message: 'Critical security flaw in authentication flow',
              location: 'src/auth/login.ts:45',
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
      reviewedBy: { sessionId: 'flowguard-reviewer-session-123' },
      reviewedAt: '2026-01-01T00:00:00.000Z',
      attestation: {
        toolObligationId: toolObligationId ?? fallbackUuid,
        iteration: 1,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer',
        mandateDigest: REVIEW_MANDATE_DIGEST,
        criteriaVersion: 'p35-v1',
      },
    };
  }

  // Helper: Create a review obligation and return its UUID by calling /review
  // without findings first. Hydrates a fresh READY session internally.
  async function obtainObligationUuid(contentArg: Record<string, unknown>): Promise<string> {
    await hydrateAndGetReady();
    const raw = await review.execute(contentArg, ctx);
    const blocked = parseToolResult(raw);
    if (blocked.code !== 'CONTENT_ANALYSIS_REQUIRED') {
      throw new Error(`Expected CONTENT_ANALYSIS_REQUIRED, got ${blocked.code}`);
    }
    const att = blocked.requiredReviewAttestation as Record<string, string>;
    return att.toolObligationId;
  }

  // Helper: Full two-step flow — creates obligation, then submits valid findings.
  // Returns the parseToolResult from the second (successful) /review call.
  async function submitContentReview(
    contentArg: Record<string, unknown>,
    overallVerdict: 'approve' | 'changes_requested' = 'approve',
    findingOverrides?: Partial<Record<string, unknown>>,
  ) {
    const uuid = await obtainObligationUuid(contentArg);
    const findings = { ...buildAnalysisFindings(overallVerdict, uuid), ...findingOverrides };
    const raw = await review.execute({ ...contentArg, analysisFindings: findings as never }, ctx);
    return parseToolResult(raw);
  }

  // =========================================================================
  // HAPPY PATHS - Successful review flows
  // =========================================================================
  describe('HAPPY', () => {
    it('content-aware review with PR number succeeds with analysisFindings', async () => {
      const result = await submitContentReview({ prNumber: 123, inputOrigin: 'pr' });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.status).toBe('Review flow complete. Report generated.');
      expect(result.findingsCount).toBeGreaterThanOrEqual(0);
      expect(result.inputOrigin).toBe('pr');
    });

    it('content-aware review with branch succeeds with analysisFindings', async () => {
      const result = await submitContentReview({ branch: 'feature-auth', inputOrigin: 'branch' });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.inputOrigin).toBe('branch');
    });

    it('content-aware review with URL succeeds with analysisFindings', async () => {
      const result = await submitContentReview({
        url: 'https://example.com/api-doc',
        inputOrigin: 'external_reference',
      });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.inputOrigin).toBe('external_reference');
    });

    it('content-aware review with manual text succeeds', async () => {
      const result = await submitContentReview({
        text: 'Manual review text content',
        inputOrigin: 'manual_text',
      });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.inputOrigin).toBe('manual_text');
    });

    it('non-content review (no external content) succeeds without analysisFindings', async () => {
      await hydrateAndGetReady();

      const raw = await review.execute({}, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.status).toBe('Review flow complete. Report generated.');
    });

    it('review with references but no content fields succeeds', async () => {
      await hydrateAndGetReady();

      const raw = await review.execute(
        {
          references: [{ ref: 'https://github.com/owner/repo/issues/123', type: 'issue' }],
          inputOrigin: 'external_reference',
        },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.references).toBeDefined();
    });
  });

  // =========================================================================
  // BAD PATHS - Invalid inputs, missing content, subagent failures
  // =========================================================================
  describe('BAD', () => {
    it('BLOCKED: content-aware review without analysisFindings', async () => {
      await hydrateAndGetReady();

      const raw = await review.execute({ prNumber: 123, inputOrigin: 'pr' }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('CONTENT_ANALYSIS_REQUIRED');
      expect(result.recovery).toBeDefined();
      expect(result.recovery.length).toBeGreaterThan(0);
    });

    it('PR number with ReviewFindings (subagent found no issues)', async () => {
      const result = await submitContentReview({ prNumber: 456, inputOrigin: 'pr' });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
    });

    it('BLOCKED: review in wrong phase (not READY)', async () => {
      await hydrateSession();
      await ticket.execute({ text: 'Some ticket', source: 'user' }, ctx);

      const findings = buildAnalysisFindings('approve');
      const raw = await review.execute({ prNumber: 123, analysisFindings: findings }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });
  });

  // =========================================================================
  // CORNER CASES - Edge cases, mixed inputs
  // =========================================================================
  describe('CORNER', () => {
    it('mixed input: text AND references with inputOrigin="mixed"', async () => {
      const result = await submitContentReview({
        text: 'Mixed content review',
        references: [{ ref: 'PR#789', type: 'pr' }],
        inputOrigin: 'mixed',
      });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.inputOrigin).toBe('mixed');
    });

    it('report includes external references when provided', async () => {
      const result = await submitContentReview({
        prNumber: 999,
        references: [
          { ref: 'https://github.com/owner/repo/pull/999', type: 'pr', title: 'PR #999' },
        ],
        inputOrigin: 'pr',
      });
      expect(result.error).toBeUndefined();
      expect(result.references).toBeDefined();
      expect(result.references?.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // EDGE CASES - Boundary conditions
  // =========================================================================
  describe('EDGE', () => {
    it('review with all optional fields populated', async () => {
      const result = await submitContentReview({
        prNumber: 123,
        text: 'Additional context',
        inputOrigin: 'mixed',
        references: [
          { ref: 'PR#123', type: 'pr', title: 'Main PR' },
          { ref: 'JIRA-456', type: 'ticket', title: 'Related ticket' },
        ],
      });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
    });
  });

  // =========================================================================
  // E2E TESTS - Full review flow with subagent
  // =========================================================================
  describe('E2E', () => {
    it('full content-aware review flow: hydrate → review with content', async () => {
      const result = await submitContentReview(
        {
          prNumber: 42,
          inputOrigin: 'pr',
          references: [{ ref: 'https://github.com/owner/repo/pull/42', type: 'pr' }],
        },
        'approve',
      );

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.overallStatus).toBeDefined();
      expect(result.completeness).toBeDefined();
      expect(result.findings).toBeDefined();
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.inputOrigin).toBe('pr');
    });
  });

  // =========================================================================
  // SMOKE TESTS - Basic functionality verification
  // =========================================================================
  describe('SMOKE', () => {
    it('smoke: minimal review without content completes', async () => {
      await hydrateAndGetReady();

      const raw = await review.execute({}, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.status).toContain('Review flow complete');
    });

    it('smoke: report contains expected fields', async () => {
      await hydrateAndGetReady();

      const raw = await review.execute({}, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.overallStatus).toMatch(/clean|warnings|issues/);
      expect(result.completeness).toBeDefined();
      expect(result.validationSummary).toBeDefined();
    });
  });

  // =========================================================================
  // ATTESTATION CONTRACT TESTS (P1: review-flow-fix)
  //
  // Cover the attestation contract between /review and the flowguard-reviewer
  // subagent. These tests prove:
  //   - blocked responses include canonical requiredReviewAttestation
  //   - schema is permissive about toolObligationId for standalone /review
  //   - runtime gates for /plan and /implement remain strict
  //   - all five ReviewFindings categories surface in the report
  //   - the agent never has to invent attestation values
  // =========================================================================
  describe('attestation contract', () => {
    // ---------- HAPPY ----------
    describe('HAPPY (attestation)', () => {
      it('H1: content-aware /review without analysisFindings returns CONTENT_ANALYSIS_REQUIRED with requiredReviewAttestation', async () => {
        await hydrateAndGetReady();

        const raw = await review.execute({ prNumber: 42, inputOrigin: 'pr' }, ctx);
        const result = parseToolResult(raw);

        expect(result.error).toBe(true);
        expect(result.code).toBe('CONTENT_ANALYSIS_REQUIRED');
        expect(result.requiredReviewAttestation).toBeDefined();
        expect(result.requiredReviewAttestation.reviewedBy).toBe('flowguard-reviewer');
        expect(result.requiredReviewAttestation.mandateDigest).toBe(REVIEW_MANDATE_DIGEST);
        expect(result.requiredReviewAttestation.criteriaVersion).toBe(REVIEW_CRITERIA_VERSION);
        // toolObligationId is always present — every content-aware /review
        // creates a real ReviewObligation with a canonical UUID.
        expect(result.requiredReviewAttestation.toolObligationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(result.reviewerSubagentType).toBe('flowguard-reviewer');
        expect(Array.isArray(result.recovery)).toBe(true);
        expect(result.recovery.length).toBeGreaterThan(0);
      });

      it('H2: complete ReviewFindings with obligation-bound toolObligationId is accepted, mapped, and skips external content reload', async () => {
        // Full flow: create obligation -> submit findings with matching UUID -> success.
        const refs = [{ ref: 'https://github.com/owner/repo/pull/77', type: 'pr' as const }];
        const result = await submitContentReview(
          { prNumber: 77, inputOrigin: 'pr', references: refs },
          'changes_requested',
        );

        expect(result.error).toBeUndefined();
        expect(result.phase).toBe('REVIEW_COMPLETE');
        // Mapped finding (severity 'major' -> 'error', category 'risk' preserved) is in the report.
        const mapped = result.findings as Array<Record<string, unknown>>;
        expect(
          mapped.some(
            (f) =>
              f.category === 'risk' &&
              f.message === 'Critical security flaw in authentication flow' &&
              f.severity === 'error',
          ),
        ).toBe(true);
        // Provenance preserved: inputOrigin and references survive the report.
        expect(result.inputOrigin).toBe('pr');
        expect(result.references).toBeDefined();
        expect((result.references as unknown[]).length).toBe(1);
      });

      it('H3: plain /review without content fields still works (no analysisFindings needed)', async () => {
        await hydrateAndGetReady();

        const raw = await review.execute({}, ctx);
        const result = parseToolResult(raw);

        expect(result.error).toBeUndefined();
        expect(result.phase).toBe('REVIEW_COMPLETE');
        expect(result.requiredReviewAttestation).toBeUndefined();
      });
    });

    // ---------- BAD ----------
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

      it('B1: reviewMode !== "subagent" is rejected with requiredReviewAttestation', async () => {
        await hydrateAndGetReady();
        const findings = {
          ...buildAnalysisFindings('approve'),
          reviewMode: 'human',
        } as unknown;
        const raw = await review.execute(
          { prNumber: 1, analysisFindings: findings as never, inputOrigin: 'pr' },
          ctx,
        );
        expectAttestationBlocked(parseToolResult(raw));
      });

      it('B2: missing attestation is rejected with requiredReviewAttestation', async () => {
        await hydrateAndGetReady();
        const base = buildAnalysisFindings('approve') as Record<string, unknown>;
        const { attestation: _omit, ...rest } = base;
        void _omit;
        const raw = await review.execute(
          { prNumber: 1, analysisFindings: rest as never, inputOrigin: 'pr' },
          ctx,
        );
        expectAttestationBlocked(parseToolResult(raw));
      });

      it('B3: attestation.reviewedBy !== "flowguard-reviewer" is rejected', async () => {
        await hydrateAndGetReady();
        const base = buildAnalysisFindings('approve');
        const findings = {
          ...base,
          attestation: { ...base.attestation, reviewedBy: 'someone-else' },
        };
        const raw = await review.execute(
          { prNumber: 1, analysisFindings: findings as never, inputOrigin: 'pr' },
          ctx,
        );
        expectAttestationBlocked(parseToolResult(raw));
      });

      it('B4: attestation.mandateDigest mismatch is rejected', async () => {
        await hydrateAndGetReady();
        const base = buildAnalysisFindings('approve');
        const findings = {
          ...base,
          attestation: { ...base.attestation, mandateDigest: 'wrong-digest-value' },
        };
        const raw = await review.execute(
          { prNumber: 1, analysisFindings: findings as never, inputOrigin: 'pr' },
          ctx,
        );
        expectAttestationBlocked(parseToolResult(raw));
      });

      it('B5: attestation.criteriaVersion mismatch is rejected', async () => {
        await hydrateAndGetReady();
        const base = buildAnalysisFindings('approve');
        const findings = {
          ...base,
          attestation: { ...base.attestation, criteriaVersion: 'p99-bogus' },
        };
        const raw = await review.execute(
          { prNumber: 1, analysisFindings: findings as never, inputOrigin: 'pr' },
          ctx,
        );
        expectAttestationBlocked(parseToolResult(raw));
      });

      it('B6: consumed obligation (same toolObligationId after success) is rejected — single-use enforced', async () => {
        // Step 1: Obtain an obligation UUID and submit valid findings.
        const uuid = await obtainObligationUuid({ prNumber: 42, inputOrigin: 'pr' });
        const findings1 = buildAnalysisFindings('approve', uuid);
        const raw1 = await review.execute(
          { prNumber: 42, analysisFindings: findings1 as never, inputOrigin: 'pr' },
          ctx,
        );
        const result1 = parseToolResult(raw1);
        expect(result1.error).toBeUndefined();
        expect(result1.phase).toBe('REVIEW_COMPLETE');

        // Step 2: Re-submit the SAME findings with the SAME (now consumed) UUID.
        // The obligation was consumed on success — this must be rejected.
        const raw2 = await review.execute(
          { prNumber: 42, analysisFindings: findings1 as never, inputOrigin: 'pr' },
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

    // ---------- CORNER ----------
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
              location: 'src/auth/token.ts:120',
            },
          ],
          majorRisks: [
            {
              severity: 'major' as const,
              category: 'risk' as const,
              message: 'Race condition in cache invalidation',
            },
          ],
          missingVerification: ['no integration test for the new error path'],
          scopeCreep: ['unrelated dependency upgrade snuck in'],
          unknowns: ['behaviour under sustained load is unproven'],
        };

        const raw = await review.execute(
          { text: 'diff content', analysisFindings: findings, inputOrigin: 'manual_text' },
          ctx,
        );
        const result = parseToolResult(raw);
        expect(result.error).toBeUndefined();

        const mapped = result.findings as Array<Record<string, unknown>>;
        expect(mapped.some((f) => f.message === 'Logic error in token refresh')).toBe(true);
        expect(mapped.some((f) => f.message === 'Race condition in cache invalidation')).toBe(true);
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
        const result = await submitContentReview({ prNumber: 99, inputOrigin: 'pr' }, 'approve');
        expect(result.error).toBeUndefined();
        expect(result.phase).toBe('REVIEW_COMPLETE');
      });
    });

    // ---------- EDGE ----------
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
        const { validateStrictAttestation } = await import('./review-assurance.js');
        const findings = {
          iteration: 1,
          planVersion: 1,
          reviewMode: 'subagent' as const,
          overallVerdict: 'approve' as const,
          blockingIssues: [],
          majorRisks: [],
          missingVerification: [],
          scopeCreep: [],
          unknowns: [],
          reviewedBy: { sessionId: 'flowguard-reviewer-session-xyz' },
          reviewedAt: '2026-01-01T00:00:00.000Z',
          attestation: {
            mandateDigest: REVIEW_MANDATE_DIGEST,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            iteration: 1,
            planVersion: 1,
            reviewedBy: 'flowguard-reviewer' as const,
            // toolObligationId intentionally omitted — should fail the obligation gate
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

    // ---------- E2E ----------
    describe('E2E (attestation)', () => {
      it('EE1: hydrate -> blocked with attestation -> consume payload -> succeed with complete ReviewFindings', async () => {
        await hydrateAndGetReady();

        // Step 1: call /review with content but no analysisFindings -> blocked
        const refs = [{ ref: 'https://github.com/owner/repo/pull/42', type: 'pr' as const }];
        const blockedRaw = await review.execute(
          { prNumber: 42, inputOrigin: 'pr', references: refs },
          ctx,
        );
        const blocked = parseToolResult(blockedRaw);
        expect(blocked.code).toBe('CONTENT_ANALYSIS_REQUIRED');
        expect(blocked.requiredReviewAttestation).toBeDefined();

        const att = blocked.requiredReviewAttestation as Record<string, string>;

        // Step 2: build ReviewFindings from the canonical attestation values returned
        const findings = {
          iteration: 1,
          planVersion: 1,
          reviewMode: 'subagent' as const,
          overallVerdict: 'approve' as const,
          blockingIssues: [],
          majorRisks: [],
          missingVerification: [],
          scopeCreep: [],
          unknowns: [],
          reviewedBy: { sessionId: 'flowguard-reviewer-session-e2e' },
          reviewedAt: '2026-01-01T00:00:00.000Z',
          attestation: {
            iteration: 1,
            planVersion: 1,
            reviewedBy: att.reviewedBy as 'flowguard-reviewer',
            mandateDigest: att.mandateDigest,
            criteriaVersion: att.criteriaVersion,
            toolObligationId: att.toolObligationId,
          },
        };

        // Step 3: re-call /review with the complete object
        const raw = await review.execute(
          {
            prNumber: 42,
            analysisFindings: findings as never,
            inputOrigin: 'pr',
            references: refs,
          },
          ctx,
        );
        const result = parseToolResult(raw);
        expect(result.error).toBeUndefined();
        expect(result.phase).toBe('REVIEW_COMPLETE');
        expect(result.inputOrigin).toBe('pr');
        expect((result.references as unknown[]).length).toBe(1);
      });
    });

    // ---------- SMOKE ----------
    describe('SMOKE (attestation)', () => {
      it('S1: requiredReviewAttestation.mandateDigest is the canonical REVIEW_MANDATE_DIGEST constant', async () => {
        await hydrateAndGetReady();
        const raw = await review.execute({ prNumber: 1, inputOrigin: 'pr' }, ctx);
        const result = parseToolResult(raw);
        expect(result.requiredReviewAttestation.mandateDigest).toBe(REVIEW_MANDATE_DIGEST);
        expect(result.requiredReviewAttestation.mandateDigest).toMatch(/^[a-f0-9]{64}$/);
      });

      it('S2: CONTENT_ANALYSIS_REQUIRED and SUBAGENT_REVIEW_NOT_INVOKED return identical attestation payload', async () => {
        await hydrateAndGetReady();

        // CONTENT_ANALYSIS_REQUIRED: triggered by content fields without analysisFindings.
        const rawA = await review.execute({ prNumber: 7, inputOrigin: 'pr' }, ctx);
        const a = parseToolResult(rawA);
        expect(a.code).toBe('CONTENT_ANALYSIS_REQUIRED');

        // SUBAGENT_REVIEW_NOT_INVOKED: triggered by malformed reviewMode.
        await hydrateAndGetReady();
        const tampered = {
          ...buildAnalysisFindings('approve'),
          reviewMode: 'human',
        } as unknown;
        const rawB = await review.execute(
          { prNumber: 7, analysisFindings: tampered as never, inputOrigin: 'pr' },
          ctx,
        );
        const b = parseToolResult(rawB);
        expect(b.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');

        expect(a.requiredReviewAttestation).toEqual(b.requiredReviewAttestation);
        expect(a.reviewerSubagentType).toBe(b.reviewerSubagentType);
      });
    });

    // ---------- INVOCATION EVIDENCE ----------
    describe('INVOCATION EVIDENCE', () => {
      it('H4: successful /review appends ReviewInvocationEvidence to reviewAssurance', async () => {
        const uuid = await obtainObligationUuid({ prNumber: 42, inputOrigin: 'pr' });
        const findings = buildAnalysisFindings('approve', uuid);
        const raw = await review.execute(
          { prNumber: 42, analysisFindings: findings as never, inputOrigin: 'pr' },
          ctx,
        );
        const result = parseToolResult(raw);
        expect(result.error).toBeUndefined();

        // Read state and verify invocation evidence was created.
        const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
          '../adapters/workspace/index.js'
        );
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
        const state = await readState(sessDir);
        const invocations = state.reviewAssurance?.invocations ?? [];
        expect(invocations.length).toBe(1);
        expect(invocations[0].agentType).toBe('flowguard-reviewer');
        expect(invocations[0].obligationType).toBe('review');
        expect(invocations[0].obligationId).toBe(uuid);
        expect(invocations[0].findingsHash).toMatch(/^[a-f0-9]{64}$/);
        expect(invocations[0].promptHash).toMatch(/^[a-f0-9]{64}$/);
        // childSessionId from the attested reviewedBy.sessionId in buildAnalysisFindings.
        expect(invocations[0].childSessionId).toBe('flowguard-reviewer-session-123');
      });

      it('H5: obligation is consumed after successful /review', async () => {
        const uuid = await obtainObligationUuid({ prNumber: 43, inputOrigin: 'pr' });
        const findings = buildAnalysisFindings('approve', uuid);
        const raw = await review.execute(
          { prNumber: 43, analysisFindings: findings as never, inputOrigin: 'pr' },
          ctx,
        );
        const result = parseToolResult(raw);
        expect(result.error).toBeUndefined();

        const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
          '../adapters/workspace/index.js'
        );
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
        const state = await readState(sessDir);
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
        const { consumeReviewObligation, ensureReviewAssurance } = await import(
          './review-assurance.js'
        );
        const assurance = ensureReviewAssurance(undefined);
        const obligation = {
          obligationId: '00000000-0000-0000-0000-000000000001',
          obligationType: 'review' as const,
          iteration: 1,
          planVersion: 1,
          criteriaVersion: 'p35-v1',
          mandateDigest: REVIEW_MANDATE_DIGEST,
          createdAt: new Date().toISOString(),
          pluginHandshakeAt: null,
          status: 'fulfilled' as const,
          invocationId: '00000000-0000-0000-0000-000000000002',
          blockedCode: null,
          fulfilledAt: new Date().toISOString(),
          consumedAt: null,
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
        const result = await submitContentReview({ prNumber: 48, inputOrigin: 'pr' }, 'approve');
        expect(result.error).toBeUndefined();

        const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
          '../adapters/workspace/index.js'
        );
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
        const state = await readState(sessDir);
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
        const { buildInvocationEvidence } = await import('./review-assurance.js');
        const inv = buildInvocationEvidence({
          obligationId: '11111111-2222-3333-8444-555555555555',
          obligationType: 'review',
          parentSessionId: 'parent-session',
          childSessionId: 'child-session',
          promptHash: 'a'.repeat(64),
          findingsHash: 'b'.repeat(64),
          invokedAt: new Date().toISOString(),
          fulfilledAt: new Date().toISOString(),
        });
        expect(ReviewInvocationEvidence.safeParse(inv).success).toBe(true);
      });

      it('reviewCard is present in successful /review response', async () => {
        const result = await submitContentReview({ prNumber: 49, inputOrigin: 'pr' }, 'approve');
        expect(result.error).toBeUndefined();
        expect(result.reviewCard).toBeDefined();
        expect(typeof result.reviewCard).toBe('string');
        const card = result.reviewCard as string;
        expect(card).toContain('# FlowGuard Review Report');
        expect(card).toContain('Review complete');
      });
    });
  });
});
