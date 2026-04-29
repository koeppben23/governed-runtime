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
  assertTestConfigDir,
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

// =============================================================================
// Tool 3: ticket
// =============================================================================

describe('ticket', () => {
  describe('HAPPY', () => {
    it('records ticket text and stays in TICKET phase', async () => {
      await hydrateSession();
      const raw = await ticket.execute({ text: 'Fix the auth bug', source: 'user' }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('TICKET');
      expect(result.status).toBe('ok');
    });

    it('ticket is persisted in state on disk', async () => {
      await hydrateSession();
      await ticket.execute({ text: 'Fix login flow', source: 'user' }, ctx);
      // Read state directly from disk
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state!.ticket).not.toBeNull();
      expect(state!.ticket!.text).toBe('Fix login flow');
    });
  });

  describe('BAD', () => {
    it('blocks with EMPTY_TICKET for empty text', async () => {
      await hydrateSession();
      const raw = await ticket.execute({ text: '', source: 'user' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('EMPTY_TICKET');
    });

    it('blocks with NO_SESSION when no session exists', async () => {
      const raw = await ticket.execute({ text: 'Something', source: 'user' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });
  });

  describe('CORNER', () => {
    it('re-ticketing in TICKET phase replaces ticket text', async () => {
      await hydrateSession();
      await ticket.execute({ text: 'First ticket', source: 'user' }, ctx);
      await ticket.execute({ text: 'Second ticket', source: 'user' }, ctx);
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state!.ticket!.text).toBe('Second ticket');
    });

    it('re-ticketing from non-TICKET phase is blocked', async () => {
      await hydrateAndTicket('First ticket');
      // Submit plan → phase advances from TICKET
      await plan.execute({ planText: '## Plan\n1. Do stuff' }, ctx);
      // Re-ticket should be blocked (not in TICKET phase)
      const raw = await ticket.execute({ text: 'Second ticket', source: 'user' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });
  });

  describe('EDGE', () => {
    it('accepts external source', async () => {
      await hydrateSession();
      const raw = await ticket.execute({ text: 'JIRA-1234: Fix bug', source: 'external' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
    });

    it('stores references with Jira URL and extractedAt', async () => {
      await hydrateSession();
      const raw = await ticket.execute(
        {
          text: 'Fix login redirect after token expiry',
          source: 'external',
          inputOrigin: 'external_reference',
          references: [
            {
              ref: 'https://jira.example.com/browse/PROJ-123',
              type: 'ticket',
              title: 'PROJ-123: Fix login redirect',
              source: 'jira',
              extractedAt: '2026-01-15T10:00:00.000Z',
            },
          ],
        },
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
      expect(state!.ticket!.references).toHaveLength(1);
      expect(state!.ticket!.references![0]!.ref).toBe('https://jira.example.com/browse/PROJ-123');
      expect(state!.ticket!.references![0]!.type).toBe('ticket');
      expect(state!.ticket!.references![0]!.source).toBe('jira');
      expect(state!.ticket!.references![0]!.extractedAt).toBe('2026-01-15T10:00:00.000Z');
      expect(state!.ticket!.inputOrigin).toBe('external_reference');
    });

    it('stores multiple references across platforms', async () => {
      await hydrateSession();
      const raw = await ticket.execute(
        {
          text: 'Implement feature X with spec alignment',
          source: 'external',
          inputOrigin: 'mixed',
          references: [
            { ref: 'https://jira.example.com/PROJ-42', type: 'ticket', source: 'jira' },
            { ref: 'https://confluence.example.com/SPEC-1', type: 'doc', source: 'confluence' },
            { ref: 'https://github.com/org/repo/issues/7', type: 'issue', source: 'github' },
          ],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
    });

    it('sets inputOrigin=manual_text for user-typed tickets', async () => {
      await hydrateSession();
      const raw = await ticket.execute(
        { text: 'Fix the auth bug in login.ts', source: 'user', inputOrigin: 'manual_text' },
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
      expect(state!.ticket!.inputOrigin).toBe('manual_text');
      expect(state!.ticket!.references).toBeUndefined();
    });

    it('normalizes empty references array (not persisted)', async () => {
      await hydrateSession();
      const raw = await ticket.execute(
        { text: 'Just a task', source: 'user', references: [] },
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
      expect(state!.ticket!.references).toBeUndefined();
    });
  });
});

// =============================================================================
// Tool 4: plan
// =============================================================================

describe('plan', () => {
  const modeBSubagentFindings = {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent' as const,
    overallVerdict: 'approve' as const,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_subagent_mode_b' },
    reviewedAt: new Date().toISOString(),
  };

  const modeBSelfFindings = {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'self' as unknown as 'subagent',
    overallVerdict: 'approve' as const,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: 'ses_self_mode_b' },
    reviewedAt: new Date().toISOString(),
  };

  describe('HAPPY', () => {
    it('Mode A: records initial plan with digest', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute({ planText: '## Plan\n1. Fix auth\n2. Add tests' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.planDigest).toBeTruthy();
      expect(result.selfReviewIteration).toBe(0);
    });

    it('Mode B: approve converges after mandatory subagent review', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'approve');
      const raw = await plan.execute({ selfReviewVerdict: 'approve', reviewFindings }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      // In solo mode, max iterations is 1, so should converge
      expect(
        result.converged === true ||
          result.phase === 'PLAN_REVIEW' ||
          result.phase === 'VALIDATION',
      ).toBe(true);
    });

    it('Mode B: changes_requested with revised plan', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Original Plan' }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'changes_requested');
      const raw = await plan.execute(
        {
          selfReviewVerdict: 'changes_requested',
          planText: '## Revised Plan\n1. Better approach',
          reviewFindings,
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
    });

    it('Mode B changes_requested keeps selfReviewIteration aligned with next iteration metadata', async () => {
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);

      await plan.execute({ planText: '## Original Plan' }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'changes_requested');
      const raw = await plan.execute(
        {
          selfReviewVerdict: 'changes_requested',
          planText: '## Revised Plan\n1. Better approach',
          reviewFindings,
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(typeof result.selfReviewIteration).toBe('number');
      expect(typeof result.next).toBe('string');

      const nextText = result.next as string;
      const iterMatch = nextText.match(/iteration[=:\s]+(\d+)/i);
      expect(iterMatch).not.toBeNull();
      const nextIteration = Number.parseInt(iterMatch![1]!, 10);

      expect(nextIteration).toBe(result.selfReviewIteration as number);
    });
  });

  describe('BAD', () => {
    it('blocks with EMPTY_PLAN for empty planText', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute({ planText: '' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('EMPTY_PLAN');
    });

    it('blocks in READY phase (command not allowed without ticket phase)', async () => {
      await hydrateSession();
      const raw = await plan.execute({ planText: '## Plan' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });

    it('blocks without session', async () => {
      const raw = await plan.execute({ planText: '## Plan' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });
  });

  describe('CORNER', () => {
    it('Mode B changes_requested requires revised planText', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan' }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'changes_requested');
      const raw = await plan.execute(
        { selfReviewVerdict: 'changes_requested', reviewFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVISED_PLAN_REQUIRED');
    });

    it('Mode B uses mandatory subagent review even when old snapshots are weakened', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan' }, ctx);

      const reviewFindings = await fulfillPlanReview(0, 'changes_requested');
      const raw = await plan.execute(
        {
          selfReviewVerdict: 'changes_requested',
          planText: '## Revised Plan',
          reviewFindings,
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.reviewMode).toBe('subagent');
    });

    it('Mode B blocks self findings when fallbackToSelf=false and subagentEnabled=true', async () => {
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

      await plan.execute({ planText: '## Plan' }, ctx);
      const findings = { ...modeBSelfFindings };
      const raw = await plan.execute(
        {
          selfReviewVerdict: 'changes_requested',
          planText: '## Revised Plan',
          reviewFindings: findings,
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
    });

    it('Mode B blocks with NO_SELF_REVIEW when selfReview is null', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan' }, ctx);

      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      await writeState(sessDir, {
        ...state!,
        selfReview: null,
      });

      const raw = await plan.execute({ selfReviewVerdict: 'approve' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SELF_REVIEW');
    });

    it('Mode B blocks with NO_PLAN when plan is null', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan' }, ctx);

      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      await writeState(sessDir, {
        ...state!,
        plan: null,
      });

      const raw = await plan.execute({ selfReviewVerdict: 'approve' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_PLAN');
    });

    it('converged PLAN_REVIEW response contains reviewCard with full plan body', async () => {
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Implement payment validation', source: 'user' }, ctx);
      const planText =
        '## Plan\n\n### Objective\nImplement payment validation.\n\n### Approach\nUse a validation pipeline.\n\n### Steps\n1. Add `validate.ts`.\n2. Add tests.\n\n### Files to Modify\n- `src/payments/validate.ts`\n\n### Edge Cases\n1. Empty input.\n\n### Validation Criteria\n1. `npm test` passes.\n\n### Verification Plan\n1. `npm test` — Source: package.json:scripts.test';
      await plan.execute({ planText }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'approve');
      const raw = await plan.execute({ selfReviewVerdict: 'approve', reviewFindings }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.reviewCard).toBeTypeOf('string');
      expect(result.reviewCard).toContain('# FlowGuard Plan Review');
      expect(result.reviewCard).toContain('## Proposed Plan');
      expect(result.reviewCard).toContain('Implement payment validation');
      expect(result.reviewCard).toContain('## Next recommended action');
    });

    it('converged PLAN_REVIEW reviewCard contains recommended commands', async () => {
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Fix auth', source: 'user' }, ctx);
      await plan.execute({ planText: '## Plan\n1. Fix auth\n2. Add tests' }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'approve');
      const raw = await plan.execute({ selfReviewVerdict: 'approve', reviewFindings }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.reviewCard).toContain('- `/approve`');
      expect(result.reviewCard).toContain('- `/request-changes`');
      expect(result.reviewCard).toContain('- `/reject`');
    });

    it('non-PLAN_REVIEW convergence (solo auto-advance) does not include reviewCard', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'approve');
      const raw = await plan.execute({ selfReviewVerdict: 'approve', reviewFindings }, ctx);
      const result = parseToolResult(raw);

      // Solo auto-advances through VALIDATION; if phase is not PLAN_REVIEW, no card
      if (result.phase !== 'PLAN_REVIEW') {
        expect(result.reviewCard).toBeUndefined();
      }
    });
  });

  describe('assertTestConfigDir (test safety guard)', () => {
    it('HAPPY: passes when OPENCODE_CONFIG_DIR is set to a temp directory', async () => {
      const ws = await createTestWorkspace();
      expect(() => assertTestConfigDir()).not.toThrow();
      await ws.cleanup();
    });

    it('BAD: throws when OPENCODE_CONFIG_DIR is not set', () => {
      const original = process.env.OPENCODE_CONFIG_DIR;
      delete process.env.OPENCODE_CONFIG_DIR;
      try {
        expect(() => assertTestConfigDir()).toThrow('Unsafe OPENCODE_CONFIG_DIR');
      } finally {
        if (original) process.env.OPENCODE_CONFIG_DIR = original;
      }
    });

    it('BAD: throws when OPENCODE_CONFIG_DIR points to non-temp directory', () => {
      const original = process.env.OPENCODE_CONFIG_DIR;
      process.env.OPENCODE_CONFIG_DIR = '/Users/home/.config/opencode';
      try {
        expect(() => assertTestConfigDir()).toThrow('Unsafe OPENCODE_CONFIG_DIR');
      } finally {
        if (original) process.env.OPENCODE_CONFIG_DIR = original;
        else delete process.env.OPENCODE_CONFIG_DIR;
      }
    });
  });
});
