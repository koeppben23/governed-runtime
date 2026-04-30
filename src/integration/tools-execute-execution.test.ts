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

async function fulfillReview(
  obligationType: 'plan' | 'implement',
  iteration: number,
  overallVerdict: 'approve' | 'changes_requested' = 'approve',
) {
  return fulfillStrictReviewObligation(await currentSessionDir(), {
    obligationType,
    iteration,
    planVersion: 1,
    overallVerdict,
  });
}

describe('implement', () => {
  /** Helper: reach IMPLEMENTATION phase via solo workflow. */
  async function reachImplementation(): Promise<void> {
    await hydrateAndTicket();
    await plan.execute({ planText: '## Plan\n1. Fix auth' }, ctx);
    const planReviewFindings = await fulfillReview('plan', 0, 'approve');
    await plan.execute({ selfReviewVerdict: 'approve', reviewFindings: planReviewFindings }, ctx);
    // Solo: PLAN_REVIEW auto-approves → VALIDATION
    // Submit validation results
    await validate.execute(
      {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'OK' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      },
      ctx,
    );
  }

  describe('HAPPY', () => {
    it('Mode A: records changed files from git', async () => {
      await reachImplementation();
      const raw = await implement.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.changedFiles).toBeDefined();
      expect(result.domainFiles).toBeDefined();
    });

    it('Mode B: approve review converges in solo', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);
      const reviewFindings = await fulfillReview('implement', 1, 'approve');
      const raw = await implement.execute({ reviewVerdict: 'approve', reviewFindings }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(
        result.converged === true ||
          result.phase === 'EVIDENCE_REVIEW' ||
          result.phase === 'COMPLETE',
      ).toBe(true);
    });
  });

  describe('BAD', () => {
    it('blocks without session', async () => {
      const raw = await implement.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });

    it('blocks without plan/ticket', async () => {
      await hydrateSession();
      const raw = await implement.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
    });
  });

  describe('CORNER', () => {
    it('filters out .opencode/ files from domain files', async () => {
      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce([
        'src/foo.ts',
        '.opencode/tools/flowguard.ts',
        'node_modules/dep/index.js',
      ]);
      await reachImplementation();
      const raw = await implement.execute({}, ctx);
      const result = parseToolResult(raw);
      const domain = result.domainFiles as string[];
      expect(domain).toContain('src/foo.ts');
      expect(domain).not.toContain('.opencode/tools/flowguard.ts');
      expect(domain).not.toContain('node_modules/dep/index.js');
    });

    it('Mode B blocks with IMPLEMENTATION_EVIDENCE_REQUIRED before evidence is recorded', async () => {
      await reachImplementation();
      const raw = await implement.execute({ reviewVerdict: 'approve' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('IMPLEMENTATION_EVIDENCE_REQUIRED');
    });

    it('Mode B blocks with IMPLEMENTATION_EVIDENCE_REQUIRED when implementation is null', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);

      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      await writeState(sessDir, {
        ...state!,
        implementation: null,
      });

      const raw = await implement.execute({ reviewVerdict: 'approve' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('IMPLEMENTATION_EVIDENCE_REQUIRED');
    });
  });

  describe('P34b: Agent-Orchestrated Implementation Review', () => {
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

    async function setSelfReviewPolicy(
      subagentEnabled: boolean,
      fallbackToSelf: boolean,
    ): Promise<void> {
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
          selfReview: { subagentEnabled, fallbackToSelf },
        },
      });
    }

    async function enterImplReview(): Promise<void> {
      await implement.execute({}, ctx);
    }

    it('reviewMode=subagent accepted by mandatory default in Mode B', async () => {
      await reachImplementation();
      await enterImplReview();
      const reviewFindings = await fulfillReview('implement', 1, 'approve');
      const raw = await implement.execute({ reviewVerdict: 'approve', reviewFindings }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.latestImplementationReview.reviewMode).toBe('subagent');
    });

    it('reviewMode=self blocked by mandatory default in Mode B', async () => {
      await reachImplementation();
      await enterImplReview();
      const raw = await implement.execute(
        {
          reviewVerdict: 'approve',
          reviewFindings: { ...validReviewFindingsSelf, iteration: 1 },
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
    });

    it('planVersion mismatch blocked in Mode B', async () => {
      await reachImplementation();
      await enterImplReview();
      const wrongVersion = { ...validReviewFindingsSubagent, iteration: 1, planVersion: 99 };
      const raw = await implement.execute(
        {
          reviewVerdict: 'changes_requested',
          reviewFindings: wrongVersion,
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('reviewFindings without reviewVerdict blocks with INVALID_IMPLEMENT_TOOL_SEQUENCE', async () => {
      await reachImplementation();
      const raw = await implement.execute({ reviewFindings: validReviewFindingsSubagent }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('INVALID_IMPLEMENT_TOOL_SEQUENCE');
    });

    it('subagentEnabled=true + reviewMode=subagent -> accepted in Mode B', async () => {
      await reachImplementation();
      await setSelfReviewPolicy(true, false);
      await enterImplReview();
      const reviewFindings = await fulfillReview('implement', 1, 'approve');
      const raw = await implement.execute({ reviewVerdict: 'approve', reviewFindings }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.latestImplementationReview).toBeTruthy();
      expect(result.latestImplementationReview.reviewMode).toBe('subagent');
    });

    it('subagentEnabled=true + fallbackToSelf=true + reviewMode=self -> BLOCKED in Mode B', async () => {
      await reachImplementation();
      await setSelfReviewPolicy(true, true);
      await enterImplReview();
      const raw = await implement.execute(
        {
          reviewVerdict: 'approve',
          reviewFindings: { ...validReviewFindingsSelf, iteration: 1 },
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
    });

    it('subagentEnabled=true + fallbackToSelf=false + reviewMode=self -> BLOCKED in Mode B', async () => {
      await reachImplementation();
      await setSelfReviewPolicy(true, false);
      await enterImplReview();
      const raw = await implement.execute(
        {
          reviewVerdict: 'approve',
          reviewFindings: { ...validReviewFindingsSelf, iteration: 1 },
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
    });

    it('Mode B: missing mandatory reviewer findings blocks approve', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);
      const raw = await implement.execute({ reviewVerdict: 'approve' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_FINDINGS_REQUIRED');
    });

    it('Mode B: reviewMode=self blocked when subagentEnabled=true and fallbackToSelf=false', async () => {
      await reachImplementation();
      await setSelfReviewPolicy(true, false);
      await enterImplReview();

      const modeBFindings = { ...validReviewFindingsSelf, iteration: 1 };
      const raw = await implement.execute(
        { reviewVerdict: 'changes_requested', reviewFindings: modeBFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
    });

    it('Mode B: planVersion mismatch blocked', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);

      const wrongVersion = { ...validReviewFindingsSubagent, iteration: 1, planVersion: 99 };
      const raw = await implement.execute(
        { reviewVerdict: 'changes_requested', reviewFindings: wrongVersion },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('Mode B: iteration mismatch blocked', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);

      const wrongIteration = { ...validReviewFindingsSubagent, iteration: 99 };
      const raw = await implement.execute(
        { reviewVerdict: 'changes_requested', reviewFindings: wrongIteration },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_ITERATION_MISMATCH');
    });

    it('Mode B: changes_requested accepted with valid reviewFindings', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);

      const validModeBFindings = await fulfillReview('implement', 1, 'changes_requested');
      const raw = await implement.execute(
        { reviewVerdict: 'changes_requested', reviewFindings: validModeBFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.status).toContain('Changes requested');
    });

    it('approve + subagentEnabled=true + missing reviewFindings -> BLOCKED', async () => {
      await reachImplementation();
      await setSelfReviewPolicy(true, false);
      await implement.execute({}, ctx);

      const raw = await implement.execute({ reviewVerdict: 'approve' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_FINDINGS_REQUIRED');
    });

    it('approve + subagentEnabled=true + valid reviewFindings -> accepted', async () => {
      await reachImplementation();
      await setSelfReviewPolicy(true, false);

      await enterImplReview();
      const modeBFindings = await fulfillReview('implement', 1, 'approve');
      const raw = await implement.execute(
        { reviewVerdict: 'approve', reviewFindings: modeBFindings },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.implReviewIteration).toBeGreaterThanOrEqual(1);
      expect(result.latestImplementationReview).toBeTruthy();
      expect(result.latestImplementationReview.reviewMode).toBe('subagent');
    });

    it('blocks tampered implementation review findings that do not match evidence', async () => {
      await reachImplementation();
      await enterImplReview();
      const reviewFindings = await fulfillReview('implement', 1, 'approve');

      const raw = await implement.execute(
        {
          reviewVerdict: 'approve',
          reviewFindings: {
            ...reviewFindings,
            missingVerification: ['tampered verification gap'],
          },
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_FINDINGS_HASH_MISMATCH');
    });

    it('persists implReviewFindings in state', async () => {
      await reachImplementation();
      await enterImplReview();
      const reviewFindings = await fulfillReview('implement', 1, 'approve');
      await implement.execute({ reviewVerdict: 'approve', reviewFindings }, ctx);

      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);

      expect(state.implReviewFindings).toHaveLength(1);
      expect(state.implReviewFindings?.[0].reviewMode).toBe('subagent');
    });

    it('latestImplementationReview appears in status', async () => {
      await reachImplementation();
      await enterImplReview();
      const reviewFindings = await fulfillReview('implement', 1, 'approve');
      await implement.execute({ reviewVerdict: 'approve', reviewFindings }, ctx);

      const raw = await status.execute({}, ctx);
      const result = parseToolResult(raw);

      expect(result.latestImplementationReview).toBeDefined();
      expect(result.latestImplementationReview.reviewMode).toBe('subagent');
      expect(result.latestImplementationReview.iteration).toBe(1);
    });
  });
});

// =============================================================================
// Tool 7: validate
// =============================================================================

describe('validate', () => {
  /** Helper: reach VALIDATION phase. */
  async function reachValidation(): Promise<void> {
    await hydrateAndTicket();
    await plan.execute({ planText: '## Plan' }, ctx);
    const reviewFindings = await fulfillReview('plan', 0, 'approve');
    await plan.execute({ selfReviewVerdict: 'approve', reviewFindings }, ctx);
    // Solo: auto-advances to VALIDATION
  }

  describe('HAPPY', () => {
    it('ALL_PASSED advances to IMPLEMENTATION', async () => {
      await reachValidation();
      const raw = await validate.execute(
        {
          results: [
            { checkId: 'test_quality', passed: true, detail: 'OK' },
            { checkId: 'rollback_safety', passed: true, detail: 'OK' },
          ],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('IMPLEMENTATION');
    });
  });

  describe('BAD', () => {
    it('blocks without session', async () => {
      const raw = await validate.execute(
        {
          results: [{ checkId: 'test_quality', passed: true, detail: 'OK' }],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });
  });

  describe('CORNER', () => {
    it('CHECK_FAILED returns to PLAN', async () => {
      await reachValidation();
      const raw = await validate.execute(
        {
          results: [
            { checkId: 'test_quality', passed: false, detail: 'Missing tests' },
            { checkId: 'rollback_safety', passed: true, detail: 'OK' },
          ],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PLAN');
    });

    it('blocks when required checks are missing', async () => {
      await reachValidation();
      const raw = await validate.execute(
        {
          results: [
            { checkId: 'test_quality', passed: true, detail: 'OK' },
            // Missing rollback_safety
          ],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('MISSING_CHECKS');
    });

    it('results are persisted in state', async () => {
      await reachValidation();
      await validate.execute(
        {
          results: [
            { checkId: 'test_quality', passed: true, detail: 'Tests pass' },
            { checkId: 'rollback_safety', passed: true, detail: 'Safe' },
          ],
        },
        ctx,
      );
      const s = parseToolResult(await status.execute({}, ctx));
      const vr = s.validationResults as Array<{ checkId: string; passed: boolean }>;
      expect(vr).toHaveLength(2);
      expect(vr[0].passed).toBe(true);
    });
  });
});

// =============================================================================
// Tool 8: review
// =============================================================================

describe('review', () => {
  describe('HAPPY', () => {
    it('starts review flow from READY and transitions to REVIEW_COMPLETE', async () => {
      await hydrateSession();
      const raw = await review.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.completeness).toBeDefined();
    });

    it('report includes completeness matrix', async () => {
      await hydrateSession();
      const result = parseToolResult(await review.execute({}, ctx));
      const comp = result.completeness as Record<string, unknown>;
      expect(typeof comp.overallComplete).toBe('boolean');
      expect(comp.slots).toBeDefined();
    });
  });

  describe('BAD', () => {
    it('blocks without session', async () => {
      const raw = await review.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });

    it('blocks when not in READY phase', async () => {
      await hydrateAndTicket();
      const raw = await review.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });
  });

  describe('CORNER', () => {
    it('review flow persists REVIEW_COMPLETE phase on disk', async () => {
      await hydrateSession();
      await review.execute({}, ctx);
      const s = parseToolResult(await status.execute({}, ctx));
      expect(s.phase).toBe('REVIEW_COMPLETE');
    });

    it('review with references stores them in report and on disk', async () => {
      await hydrateSession();
      const raw = await review.execute(
        {
          inputOrigin: 'pr',
          references: [
            {
              ref: 'https://github.com/org/repo/pull/42',
              type: 'pr',
              title: 'PR #42: Fix auth',
              source: 'github',
              extractedAt: '2026-01-15T10:00:00.000Z',
            },
          ],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.inputOrigin).toBe('pr');
      expect(result.references).toBeDefined();
      expect(Array.isArray(result.references)).toBe(true);
      expect((result.references as unknown[]).length).toBe(1);
      expect((result.references as Record<string, unknown>[])[0]!.ref).toBe(
        'https://github.com/org/repo/pull/42',
      );

      // Also verify the persisted report file contains references
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const reportRaw = await readFile(join(sessDir, 'review-report.json'), 'utf-8');
      const report = JSON.parse(reportRaw);
      expect(report.inputOrigin).toBe('pr');
      expect(report.references).toHaveLength(1);
      expect(report.references[0].ref).toBe('https://github.com/org/repo/pull/42');
      expect(report.references[0].type).toBe('pr');
      expect(report.references[0].source).toBe('github');
    });
  });
});

// =============================================================================
// Tool 9: abort_session
// =============================================================================

describe('abort_session', () => {
  describe('HAPPY', () => {
    it('aborts session to COMPLETE', async () => {
      await hydrateAndTicket();
      const raw = await abort_session.execute({ reason: 'Testing abort' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('COMPLETE');
    });

    it('abort is persisted on disk', async () => {
      await hydrateSession();
      await abort_session.execute({ reason: 'Done' }, ctx);
      const s = parseToolResult(await status.execute({}, ctx));
      expect(s.phase).toBe('COMPLETE');
    });
  });

  describe('BAD', () => {
    it('blocks without session', async () => {
      const raw = await abort_session.execute({ reason: 'No session' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });
  });

  describe('CORNER', () => {
    it('can abort from any non-terminal phase', async () => {
      // Abort from READY phase (after hydrate)
      await hydrateSession();
      const raw = await abort_session.execute({ reason: 'Cancel' }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('COMPLETE');
    });
  });
});
