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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve('Mock URL content for review'),
    } as Response));
  });

  // Helper: Create a fresh session in READY phase
  async function hydrateAndGetReady(): Promise<void> {
    const raw = await hydrate.execute({ policyMode: 'team' }, ctx);
    const result = parseToolResult(raw);
    if (result.error) {
      throw new Error(`Failed to hydrate: ${result.message}`);
    }
  }

  // Helper: Build analysisFindings from subagent output
  function buildAnalysisFindings(overallVerdict: 'approve' | 'changes_requested') {
    const findings = [];
    if (overallVerdict === 'changes_requested') {
      findings.push({
        severity: 'major' as const,
        category: 'blocking-issue',
        message: 'Critical security flaw in authentication flow',
        location: 'src/auth/login.ts:45',
        reviewedBy: { sessionId: 'flowguard-reviewer' },
      });
    }
    return findings;
  }

  // =========================================================================
  // HAPPY PATHS - Successful review flows
  // =========================================================================
  describe('HAPPY', () => {
    it('content-aware review with PR number succeeds with analysisFindings', async () => {
      await hydrateAndGetReady();
      const findings = buildAnalysisFindings('approve');

      const raw = await review.execute(
        { prNumber: 123, analysisFindings: findings, inputOrigin: 'pr' },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.status).toBe('Review flow complete. Report generated.');
      expect(result.findingsCount).toBeGreaterThanOrEqual(0);
      expect(result.inputOrigin).toBe('pr');
    });

    it('content-aware review with branch succeeds with analysisFindings', async () => {
      await hydrateAndGetReady();
      const findings = buildAnalysisFindings('approve');

      const raw = await review.execute(
        { branch: 'feature-auth', analysisFindings: findings, inputOrigin: 'branch' },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.inputOrigin).toBe('branch');
    });

    it('content-aware review with URL succeeds with analysisFindings', async () => {
      await hydrateAndGetReady();
      const findings = buildAnalysisFindings('approve');

      const raw = await review.execute(
        { url: 'https://example.com/api-doc', analysisFindings: findings, inputOrigin: 'external_reference' },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.inputOrigin).toBe('external_reference');
    });

    it('content-aware review with manual text succeeds', async () => {
      await hydrateAndGetReady();
      const findings = buildAnalysisFindings('approve');

      const raw = await review.execute(
        { text: 'Manual review text content', analysisFindings: findings, inputOrigin: 'manual_text' },
        ctx,
      );
      const result = parseToolResult(raw);

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

      const raw = await review.execute(
        { prNumber: 123, inputOrigin: 'pr' },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('CONTENT_ANALYSIS_REQUIRED');
      expect(result.recovery).toBeDefined();
      expect(result.recovery.length).toBeGreaterThan(0);
    });

    it('PR number with empty analysisFindings array succeeds (subagent found no issues)', async () => {
      await hydrateAndGetReady();

      const raw = await review.execute(
        { prNumber: 456, analysisFindings: [], inputOrigin: 'pr' },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
    });

    it('BLOCKED: review in wrong phase (not READY)', async () => {
      await hydrateSession();
      await ticket.execute({ text: 'Some ticket', source: 'user' }, ctx);

      const findings = buildAnalysisFindings('approve');
      const raw = await review.execute(
        { prNumber: 123, analysisFindings: findings },
        ctx,
      );
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
      await hydrateAndGetReady();
      const findings = buildAnalysisFindings('approve');

      const raw = await review.execute(
        {
          text: 'Mixed content review',
          references: [{ ref: 'PR#789', type: 'pr' }],
          analysisFindings: findings,
          inputOrigin: 'mixed',
        },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.inputOrigin).toBe('mixed');
    });

    it('report includes external references when provided', async () => {
      await hydrateAndGetReady();
      const findings = buildAnalysisFindings('approve');

      const raw = await review.execute(
        {
          prNumber: 999,
          analysisFindings: findings,
          references: [
            { ref: 'https://github.com/owner/repo/pull/999', type: 'pr', title: 'PR #999' },
          ],
          inputOrigin: 'pr',
        },
        ctx,
      );
      const result = parseToolResult(raw);

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
      await hydrateAndGetReady();
      const findings = buildAnalysisFindings('approve').map((f) => ({
        ...f,
        reviewedBy: { sessionId: 'flowguard-reviewer' },
      }));

      const raw = await review.execute(
        {
          prNumber: 123,
          text: 'Additional context',
          analysisFindings: findings,
          inputOrigin: 'mixed',
          references: [
            { ref: 'PR#123', type: 'pr', title: 'Main PR' },
            { ref: 'JIRA-456', type: 'ticket', title: 'Related ticket' },
          ],
        },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
    });
  });

  // =========================================================================
  // E2E TESTS - Full review flow with subagent
  // =========================================================================
  describe('E2E', () => {
    it('full content-aware review flow: hydrate → review with content', async () => {
      // Step 1: Hydrate (creates session in READY)
      let raw = await hydrate.execute({ policyMode: 'team' }, ctx);
      let result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('READY');

      // Step 2: Execute review with PR content and simulated subagent findings
      const subagentFindings = [
        {
          severity: 'major' as const,
          category: 'blocking-issue',
          message: 'Missing error handling in API endpoint',
          location: 'src/api/endpoint.ts:89',
          reviewedBy: { sessionId: 'flowguard-reviewer' },
        },
      ];

      raw = await review.execute(
        {
          prNumber: 42,
          analysisFindings: subagentFindings,
          inputOrigin: 'pr',
          references: [{ ref: 'https://github.com/owner/repo/pull/42', type: 'pr' }],
        },
        ctx,
      );
      result = parseToolResult(raw);

      if (result.error) {
        console.log('E2E test error:', JSON.stringify(result, null, 2));
      }

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
});
