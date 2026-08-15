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
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReviewFindings } from '../state/evidence.js';
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
  withTestEnv,
} from './test-helpers.js';
import {
  status,
  hydrate,
  ticket,
  plan,
  architecture,
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
import { clearUserDecisionIntents, recordUserDecisionIntent } from './user-decision-intent.js';
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

async function fulfillArchitectureReview(
  iteration = 0,
  overallVerdict: 'accept' | 'changes_requested' = 'accept',
) {
  return fulfillStrictReviewObligation(await currentSessionDir(), {
    obligationType: 'architecture',
    iteration,
    planVersion: 1,
    overallVerdict,
  });
}

// =============================================================================

// =============================================================================
// Tool 4: plan
// =============================================================================

describe('plan', () => {
  const modeBSubagentFindings = {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent' as const,
    overallVerdict: 'accept' as const,
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
    overallVerdict: 'accept' as const,
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
      const raw = await plan.execute(
        { planText: '## Plan\n1. Fix auth\n2. Add tests', targetPaths: ['docs/test.md'] },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.planDigest).toBeTruthy();
      expect(result.selfReviewIteration).toBe(0);
    });

    it('Mode B: approve converges after mandatory subagent review', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'accept');
      const raw = await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);
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
      await plan.execute({ planText: '## Original Plan', targetPaths: ['docs/test.md'] }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'changes_requested');
      const raw = await plan.execute(
        {
          reviewVerdict: 'changes_requested',
          planText: '## Revised Plan\n1. Better approach',
          reviewFindings,
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
    });

    it('Mode B changes_requested keeps selfReviewIteration aligned with next iteration metadata', async () => {
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);

      await plan.execute({ planText: '## Original Plan', targetPaths: ['docs/test.md'] }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'changes_requested');
      const raw = await plan.execute(
        {
          reviewVerdict: 'changes_requested',
          planText: '## Revised Plan\n1. Better approach',
          reviewFindings,
          targetPaths: ['docs/test.md'],
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
      const raw = await plan.execute({ planText: '', targetPaths: ['docs/test.md'] }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('EMPTY_PLAN');
    });

    it('blocks in READY phase (command not allowed without ticket phase)', async () => {
      await hydrateSession();
      const raw = await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });

    it('blocks without session', async () => {
      const raw = await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });

    it('normalizes mixed first-call planText + reviewVerdict into initial plan submission', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute(
        { planText: '## Plan', reviewVerdict: 'accept', targetPaths: ['docs/test.md'] },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).not.toBe(true);
      expect(result.status).toContain('Plan submitted');
      expect(result.selfReviewIteration).toBe(0);
    });

    it('normalizes incident payload and discards approval, fabricated findings, and unavailable marker', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute(
        {
          planText: '## Plan',
          reviewVerdict: 'accept',
          reviewFindings: modeBSubagentFindings,
          reviewerUnavailable: true,
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).not.toBe(true);
      expect(result.status).toContain('Plan submitted');
      expect(result.latestReview).toBeUndefined();
    });

    it('normalizes first-call planText + reviewFindings into initial plan submission', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute(
        {
          planText: '## Plan',
          reviewFindings: modeBSubagentFindings,
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).not.toBe(true);
      expect(result.status).toContain('Plan submitted');
      expect(result.latestReview).toBeUndefined();
    });

    it('normalizes initial plan submission with preemptive reviewerUnavailable', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute(
        { planText: '## Plan', reviewerUnavailable: true, targetPaths: ['docs/test.md'] },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).not.toBe(true);
      expect(result.status).toContain('Plan submitted');
    });

    it('re-emits the review instruction for a plan-only resubmission while the review loop is active', async () => {
      await hydrateAndTicket();
      const firstRaw = await plan.execute(
        { planText: '## Plan', targetPaths: ['docs/test.md'] },
        ctx,
      );
      const first = parseToolResult(firstRaw);
      expect(first.phase).toBe('PLAN');

      // SAME revision: the pending obligation re-emits its instruction.
      const raw = await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);
      const result = parseToolResult(raw);
      // No new plan/obligation: the existing review obligation re-emits its
      // instruction (awaiting_task continuation).
      expect(result.error).not.toBe(true);
      expect(result.phase).toBe('PLAN');
      expect(result.reviewObligationId).toBe(first.reviewObligationId);
      expect(result.status).toContain('pending');

      // CHANGED revision while pending: fail closed — never silently ignored.
      const changedRaw = await plan.execute(
        { planText: '## Replacement Plan', targetPaths: ['docs/test.md'] },
        ctx,
      );
      const changed = parseToolResult(changedRaw);
      expect(changed.error).toBe(true);
      expect(changed.code).toBe('REVIEW_SUBJECT_CHANGED_WHILE_PENDING');
    });

    it('blocks verdict before any plan exists with PLAN_SUBMISSION_REQUIRED', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute(
        { reviewVerdict: 'accept', reviewFindings: modeBSubagentFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('PLAN_SUBMISSION_REQUIRED');
      expect(result.recovery).toContain('Call flowguard_plan with planText first');
    });

    it('normalizes changes_requested revised plan before review loop into initial plan submission', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute(
        {
          reviewVerdict: 'changes_requested',
          planText: '## Revised Plan',
          reviewFindings: { ...modeBSubagentFindings, overallVerdict: 'changes_requested' },
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).not.toBe(true);
      expect(result.status).toContain('Plan submitted');
      expect(result.latestReview).toBeUndefined();
    });
  });

  describe('Mode-A hardblocks mid-loop', () => {
    async function setupMidLoopPlan(): Promise<void> {
      await hydrateAndTicket();
      const raw = await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('PLAN');
    }

    async function expectStateStillInPlan(): Promise<void> {
      const state = await readState(await currentSessionDir());
      expect(state!.phase).toBe('PLAN');
      expect(state!.plan).not.toBeNull();
    }

    it('blocks approval mixed with planText after the plan review loop has started', async () => {
      await setupMidLoopPlan();

      const raw = await plan.execute(
        { planText: '## Revised Plan', reviewVerdict: 'accept', targetPaths: ['docs/test.md'] },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('PLAN_APPROVE_WITH_TEXT');
      expect(result.recovery).toContain(
        'For host_task_required approval: call flowguard_plan({ reviewVerdict: "accept" }) after reviewer evidence is captured',
      );
      await expectStateStillInPlan();
    });

    it('blocks reviewFindings mixed into a plan-only resubmission after review starts', async () => {
      await setupMidLoopPlan();

      const raw = await plan.execute(
        {
          planText: '## Revised Plan',
          reviewFindings: modeBSubagentFindings,
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('PLAN_SUBMISSION_MIXED_INPUTS');
      expect(result.recovery).toContain(
        'Submit the plan with flowguard_plan({ planText, claims }) — no verdict inputs',
      );
      await expectStateStillInPlan();
    });

    it('blocks reviewerUnavailable mixed into a plan-only resubmission after review starts', async () => {
      await setupMidLoopPlan();

      const raw = await plan.execute(
        { planText: '## Revised Plan', reviewerUnavailable: true, targetPaths: ['docs/test.md'] },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBe(true);
      expect(result.code).toBe('INVALID_PLAN_TOOL_SEQUENCE');
      expect(result.recovery).toContain(
        'Do not include reviewVerdict, reviewFindings, or reviewerUnavailable in the plan submission call',
      );
      await expectStateStillInPlan();
    });
  });

  describe('Plan revision invariants', () => {
    it('persists structured claim declarations with the submitted plan', async () => {
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
      await plan.execute(
        {
          planText: '## Plan',
          claims: [
            {
              claimId: 'ed04dda1-96d3-569f-8acc-af53500de638',
              statement: 'Invalid credentials are rejected.',
              critical: false,
              claimScope: 'specific_behavior',
              authoritySectionId: 'authentication',
              expectedCheckId: 'typecheck',
            },
          ],
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );

      const state = await readState(await currentSessionDir());
      expect(state!.plan?.claimDeclarations).toEqual({
        flow: 'plan',
        version: 'v2',
        claims: [
          {
            claimId: 'ed04dda1-96d3-569f-8acc-af53500de638',
            statement: 'Invalid credentials are rejected.',
            critical: false,
            claimScope: 'specific_behavior',
            authoritySectionId: 'authentication',
            expectedCheckId: 'typecheck',
          },
        ],
      });
    });

    it('keeps plan evidence when PLAN_REVIEW changes_requested returns to PLAN', async () => {
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
      await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'accept');

      const reviewRaw = await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);
      const reviewResult = parseToolResult(reviewRaw);
      expect(reviewResult.phase).toBe('PLAN_REVIEW');

      recordUserDecision('changes_requested');
      const decisionRaw = await decision.execute(
        { verdict: 'changes_requested', rationale: 'Needs more detail' },
        ctx,
      );
      const decisionResult = parseToolResult(decisionRaw);
      expect(decisionResult.error).not.toBe(true);

      const state = await readState(await currentSessionDir());
      expect(state!.phase).toBe('PLAN');
      expect(state!.plan).not.toBeNull();
      expect(state!.selfReview).toBeNull();
    });
  });

  describe('Force-convergence at iteration limit', () => {
    // Drive the independent review loop to its iteration budget with
    // changes_requested verdicts only (reviewer never approves). Returns the
    // parsed result of the final, force-converging review call.
    //
    // Obligation bookkeeping: review #k consumes obligation (iteration k-1,
    // planVersion k) — see buildPlanSubmissionState / persistNonConvergedPlanReview.
    async function exhaustPlanReviews(maxIterations: number): Promise<Record<string, unknown>> {
      await plan.execute({ planText: '## Plan v0', targetPaths: ['docs/test.md'] }, ctx);
      const sessDir = await currentSessionDir();
      let last: Record<string, unknown> = {};
      for (let k = 1; k <= maxIterations; k++) {
        const findings = await fulfillStrictReviewObligation(sessDir, {
          obligationType: 'plan',
          iteration: k - 1,
          planVersion: k,
          overallVerdict: 'changes_requested',
        });
        const raw = await plan.execute(
          {
            reviewVerdict: 'changes_requested',
            planText: `## Revised plan ${k}`,
            reviewFindings: findings,
            targetPaths: ['docs/test.md'],
          },
          ctx,
        );
        last = parseToolResult(raw);
      }
      return last;
    }

    it('TEAM: presents the plan at the human gate instead of blocking (#508 regression)', async () => {
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Fix the auth bug', source: 'user' }, ctx);

      // TEAM maxSelfReviewIterations = 3 (SOLO=2) — see config/policy-presets.
      const result = await exhaustPlanReviews(3);

      // Never a block — the old MAX_REVIEW_ITERATIONS_REACHED hard block wedged
      // the session at PLAN_REVIEW with an inadmissible "/plan" recovery.
      expect(result.error).not.toBe(true);
      expect(result.code).toBeUndefined();
      // Force-converged to the human gate; the human decides.
      expect(result.phase).toBe('PLAN_REVIEW');
      expect(result.selfReviewIteration).toBe(3);
      expect(typeof result.reviewCard).toBe('string');
      expect(result.reviewCard).toContain('Reviewer did NOT approve');
      expect(result.status).toContain('iteration limit');
      expect(result.status).toContain('without reviewer approval');
      // State on disk truly sits at the human gate.
      const state = await readState(await currentSessionDir());
      expect(state!.phase).toBe('PLAN_REVIEW');
      expect(state!.reviewDecision).toBeNull();
    });

    it('TEAM: force-converged card binds reviewer findings to the prior plan revision (F1)', async () => {
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Fix the auth bug', source: 'user' }, ctx);

      const result = await exhaustPlanReviews(3);
      expect(result.phase).toBe('PLAN_REVIEW');

      const state = await readState(await currentSessionDir());
      const reviewed = state!.reviewAssurance!.obligations.find(
        (o) => o.obligationType === 'plan' && o.iteration === 2 && o.planVersion === 3,
      );
      expect(reviewed).toBeDefined();

      const card = String(result.reviewCard);
      expect(card).toContain('⚠ These reviewer findings apply to a prior plan revision.');
      expect(card).toContain(`Reviewed digest: \`${reviewed!.subjectDigest}\``);
      expect(card).toContain(`Current digest:  \`${state!.plan!.current.digest}\``);
      expect(reviewed!.subjectDigest).not.toBe(state!.plan!.current.digest);
    });

    it('TEAM: human approve advances the force-converged plan to VALIDATION', async () => {
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Fix the auth bug', source: 'user' }, ctx);
      await exhaustPlanReviews(3);

      recordUserDecision('approve');
      const decisionResult = parseToolResult(
        await decision.execute(
          { verdict: 'approve', rationale: 'Acceptable despite open findings' },
          ctx,
        ),
      );
      expect(decisionResult.error).not.toBe(true);
      const state = await readState(await currentSessionDir());
      expect(state!.phase).toBe('VALIDATION');
      expect(state!.plan?.approvalCertificate).toMatchObject({
        flow: 'plan',
        authorityDigest: state!.plan?.current.digest,
        approvedBy: expect.any(String),
        certificateId: expect.any(String),
      });
    });

    it('TEAM: human changes_requested sends the force-converged plan back to PLAN', async () => {
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Fix the auth bug', source: 'user' }, ctx);
      await exhaustPlanReviews(3);

      recordUserDecision('changes_requested');
      const decisionResult = parseToolResult(
        await decision.execute(
          { verdict: 'changes_requested', rationale: 'Address the open findings' },
          ctx,
        ),
      );
      expect(decisionResult.error).not.toBe(true);
      const state = await readState(await currentSessionDir());
      expect(state!.phase).toBe('PLAN');
      expect(state!.plan).not.toBeNull();
      expect(state!.selfReview).toBeNull();
    });

    it('TEAM: human reject returns the force-converged plan to TICKET', async () => {
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Fix the auth bug', source: 'user' }, ctx);
      await exhaustPlanReviews(3);

      recordUserDecision('reject');
      const decisionResult = parseToolResult(
        await decision.execute({ verdict: 'reject', rationale: 'Wrong approach entirely' }, ctx),
      );
      expect(decisionResult.error).not.toBe(true);
      const state = await readState(await currentSessionDir());
      expect(state!.phase).toBe('TICKET');
    });

    it('SOLO: force-convergence runs through without blocking (no inadmissible recovery)', async () => {
      await hydrateSession({ policyMode: 'solo' });
      await ticket.execute({ text: 'Fix the auth bug', source: 'user' }, ctx);

      // SOLO maxSelfReviewIterations = 2 — see config/policy-presets.
      const result = await exhaustPlanReviews(2);

      expect(result.error).not.toBe(true);
      expect(result.code).toBeUndefined();
      // SOLO auto-approves the user gate by design → flow continues past PLAN_REVIEW.
      expect(result.phase).not.toBe('PLAN_REVIEW');
      expect(result.phase).not.toBe('PLAN');
      expect(result.status).toContain('iteration limit');
      expect(result.status).toContain('without reviewer approval');
    });
  });

  describe('CORNER', () => {
    it('Mode B changes_requested requires revised planText', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'changes_requested');
      const raw = await plan.execute({ reviewVerdict: 'changes_requested', reviewFindings }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVISED_PLAN_REQUIRED');
    });

    it('Mode B uses mandatory subagent review even when old snapshots are weakened', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);

      const reviewFindings = await fulfillPlanReview(0, 'changes_requested');
      const raw = await plan.execute(
        {
          reviewVerdict: 'changes_requested',
          planText: '## Revised Plan',
          reviewFindings,
          targetPaths: ['docs/test.md'],
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

      await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);
      const findings = { ...modeBSelfFindings, overallVerdict: 'changes_requested' as const };
      const raw = await plan.execute(
        {
          reviewVerdict: 'changes_requested',
          planText: '## Revised Plan',
          reviewFindings: findings,
          targetPaths: ['docs/test.md'],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
    });

    it('Mode B blocks tampered review findings that do not match persisted evidence', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);

      const reviewFindings = await fulfillPlanReview(0, 'accept');
      const raw = await plan.execute(
        {
          reviewVerdict: 'accept',
          reviewFindings: {
            ...reviewFindings,
            // Tamper a NON-blocking field so the payload stays internally
            // coherent (accept + empty blockingIssues) and specifically
            // exercises hash-mismatch, not the F12 coherence gate.
            missingVerification: ['tampered: no integration test'],
          },
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_FINDINGS_HASH_MISMATCH');
    });

    it('F12: blocks an accept payload carrying a blocking issue on coherence (precedes hash-mismatch)', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);

      const reviewFindings = await fulfillPlanReview(0, 'accept');
      // accept + a blocking issue is internally self-contradictory. The F12
      // coherence gate fails closed BEFORE anti-tampering hash comparison, so a
      // self-contradictory record never reaches (and cannot be masked by) the
      // hash-mismatch path.
      const raw = await plan.execute(
        {
          reviewVerdict: 'accept',
          reviewFindings: {
            ...reviewFindings,
            blockingIssues: [
              {
                severity: 'major' as const,
                category: 'correctness' as const,
                message: 'contract drift',
                location: 'test',
              },
            ],
          },
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('SUBAGENT_VERDICT_FINDINGS_INCOHERENT');
    });

    it('Mode B blocks when reviewVerdict does not match reviewFindings.overallVerdict', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'changes_requested');
      const raw = await plan.execute(
        {
          reviewVerdict: 'accept',
          reviewFindings,
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('SUBAGENT_FINDINGS_VERDICT_MISMATCH');
    });

    it('Mode B blocks with PLAN_REVIEW_LOOP_REQUIRED when selfReview is null', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);

      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      await writeState(sessDir, {
        ...state!,
        selfReview: null,
      });

      const raw = await plan.execute({ reviewVerdict: 'accept' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('PLAN_REVIEW_LOOP_REQUIRED');
    });

    it('Mode B blocks with PLAN_SUBMISSION_REQUIRED when plan is null', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan', targetPaths: ['docs/test.md'] }, ctx);

      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      await writeState(sessDir, {
        ...state!,
        plan: null,
      });

      const raw = await plan.execute({ reviewVerdict: 'accept' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('PLAN_SUBMISSION_REQUIRED');
    });

    it('converged PLAN_REVIEW response contains reviewCard with full plan body', async () => {
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Implement payment validation', source: 'user' }, ctx);
      const planText =
        '## Plan\n\n### Objective\nImplement payment validation.\n\n### Approach\nUse a validation pipeline.\n\n### Steps\n1. Add `validate.ts`.\n2. Add tests.\n\n### Files to Modify\n- `src/payments/validate.ts`\n\n### Edge Cases\n1. Empty input.\n\n### Validation Criteria\n1. `npm test` passes.\n\n### Verification Plan\n1. `npm test` — Source: package.json:scripts.test';
      await plan.execute({ planText, targetPaths: ['docs/test.md'] }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'accept');
      const raw = await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.reviewCard).toBeTypeOf('string');
      expect(result.reviewCard).toContain('# FlowGuard Plan Review');
      expect(result.reviewCard).toContain('## Proposed Plan');
      expect(result.reviewCard).toContain('Implement payment validation');
      expect(result.reviewCard).toContain('## Decision required');
      expect(result.presentation).toEqual({ markdown: result.reviewCard });
    });

    it('converged PLAN_REVIEW reviewCard contains recommended commands', async () => {
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Fix auth', source: 'user' }, ctx);
      await plan.execute(
        { planText: '## Plan\n1. Fix auth\n2. Add tests', targetPaths: ['docs/test.md'] },
        ctx,
      );
      const reviewFindings = await fulfillPlanReview(0, 'accept');
      const raw = await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.reviewCard).toContain('- `/approve`');
      expect(result.reviewCard).toContain('- `/request-changes`');
      expect(result.reviewCard).toContain('- `/reject`');
    });

    it('non-PLAN_REVIEW convergence (solo auto-advance) does not include reviewCard', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
      const reviewFindings = await fulfillPlanReview(0, 'accept');
      const raw = await plan.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);
      const result = parseToolResult(raw);

      // Solo auto-advances through VALIDATION; if phase is not PLAN_REVIEW, no card
      if (result.phase !== 'PLAN_REVIEW') {
        expect(result.reviewCard).toBeUndefined();
      }
    });
  });

  // ─── P1.3 slice 8: third-verdict end-to-end through tool layer ──────────
  describe('EDGE: unable_to_review tool-layer integration', () => {
    it('blocks plan with SUBAGENT_UNABLE_TO_REVIEW when findings.overallVerdict=unable_to_review (E2E)', async () => {
      // End-to-end: full plan submission flow, real fulfilled obligation,
      // findings mutated to unable_to_review. The tool layer (slice 4e)
      // MUST short-circuit to BLOCKED before any reviewVerdict
      // semantics are evaluated.
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan\n1. Fix auth', targetPaths: ['docs/test.md'] }, ctx);
      // fulfillPlanReview installs a valid attestation; mutate the verdict.
      const baseFindings = await fulfillPlanReview(0, 'accept');
      const unableFindings = { ...baseFindings, overallVerdict: 'unable_to_review' as const };

      const raw = await plan.execute(
        { reviewVerdict: 'changes_requested', reviewFindings: unableFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
    });

    it('blocks plan with SUBAGENT_UNABLE_TO_REVIEW even when paired with reviewVerdict=approve (E2E precedence)', async () => {
      // Slice 4e precedence: unable_to_review fails closed regardless of
      // the agent's submitted reviewVerdict. There is no path where
      // an unreviewable finding can be coerced into convergence.
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan\n1. Fix auth', targetPaths: ['docs/test.md'] }, ctx);
      const baseFindings = await fulfillPlanReview(0, 'accept');
      const unableFindings = { ...baseFindings, overallVerdict: 'unable_to_review' as const };

      const raw = await plan.execute(
        { reviewVerdict: 'accept', reviewFindings: unableFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
    });

    it('SUBAGENT_UNABLE_TO_REVIEW response carries operator recovery copy (E2E reason wiring)', async () => {
      // Slice 2 reason registration must be reachable through the full
      // tool stack (not only via the unit-level validation test).
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan\n1. Fix', targetPaths: ['docs/test.md'] }, ctx);
      const baseFindings = await fulfillPlanReview(0, 'accept');
      const unableFindings = { ...baseFindings, overallVerdict: 'unable_to_review' as const };

      const raw = await plan.execute(
        { reviewVerdict: 'accept', reviewFindings: unableFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
      // Reason must surface a non-empty recovery hint; exact wording is
      // pinned in the reason-shape tests, not here.
      expect(typeof result.recovery === 'string' || Array.isArray(result.recovery)).toBe(true);
      const recoveryText = Array.isArray(result.recovery)
        ? (result.recovery as string[]).join(' ')
        : (result.recovery as string);
      expect(recoveryText.length).toBeGreaterThan(0);
    });
  });

  // ─── F13 slice 10: architecture tool-layer EDGE pipeline ───────────────
  describe('EDGE: architecture unable_to_review tool-layer integration (F13 slice 10)', () => {
    const adrText =
      '## Context\nA database is needed.\n\n## Decision\nUse PostgreSQL.\n\n## Consequences\nMust maintain DB infra.';

    it('blocks architecture with SUBAGENT_UNABLE_TO_REVIEW when findings.overallVerdict=unable_to_review (E2E)', async () => {
      // F13 slice 10 parity with the plan EDGE test above. Full architecture
      // submission flow with a real fulfilled obligation; finding verdict
      // mutated to unable_to_review. The tool layer (slice 7c hooks
      // validateReviewFindings, which fail-closes per P1.3 slice 4e) MUST
      // short-circuit to BLOCKED before any reviewVerdict semantics
      // are evaluated.
      await hydrateSession({ policyMode: 'solo' });
      await architecture.execute(
        { title: 'PostgreSQL', adrText, targetPaths: ['docs/test.md'] },
        ctx,
      );
      const baseFindings = await fulfillArchitectureReview(0, 'accept');
      const unableFindings = { ...baseFindings, overallVerdict: 'unable_to_review' as const };

      const raw = await architecture.execute(
        { reviewVerdict: 'changes_requested', reviewFindings: unableFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
    });

    it('blocks architecture with SUBAGENT_UNABLE_TO_REVIEW even when paired with reviewVerdict=approve (E2E precedence)', async () => {
      // Slice 4e precedence parity for architecture: unable_to_review fails
      // closed regardless of the agent's submitted reviewVerdict. There
      // is no path where an unreviewable finding can be coerced into
      // architecture convergence.
      await hydrateSession({ policyMode: 'solo' });
      await architecture.execute(
        { title: 'PostgreSQL', adrText, targetPaths: ['docs/test.md'] },
        ctx,
      );
      const baseFindings = await fulfillArchitectureReview(0, 'accept');
      const unableFindings = { ...baseFindings, overallVerdict: 'unable_to_review' as const };

      const raw = await architecture.execute(
        { reviewVerdict: 'accept', reviewFindings: unableFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
    });

    it('SUBAGENT_UNABLE_TO_REVIEW response carries operator recovery copy (E2E reason wiring, architecture)', async () => {
      // Slice 2 reason registration must be reachable through the full
      // architecture tool stack, parity with the plan version above.
      await hydrateSession({ policyMode: 'solo' });
      await architecture.execute(
        { title: 'PostgreSQL', adrText, targetPaths: ['docs/test.md'] },
        ctx,
      );
      const baseFindings = await fulfillArchitectureReview(0, 'accept');
      const unableFindings = { ...baseFindings, overallVerdict: 'unable_to_review' as const };

      const raw = await architecture.execute(
        { reviewVerdict: 'accept', reviewFindings: unableFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
      expect(typeof result.recovery === 'string' || Array.isArray(result.recovery)).toBe(true);
      const recoveryText = Array.isArray(result.recovery)
        ? (result.recovery as string[]).join(' ')
        : (result.recovery as string);
      expect(recoveryText.length).toBeGreaterThan(0);
    });

    it('architecture obligation iteration matches expectedIteration (planVersion stable at 1)', async () => {
      await hydrateSession({ policyMode: 'solo' });
      await architecture.execute(
        { title: 'PostgreSQL', adrText, targetPaths: ['docs/test.md'] },
        ctx,
      );
      const baseFindings = await fulfillArchitectureReview(0, 'accept');
      const driftFindings = { ...baseFindings, planVersion: 2 };

      const raw = await architecture.execute(
        { reviewVerdict: 'accept', reviewFindings: driftFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      // The exact code is one of REVIEW_PLAN_VERSION_MISMATCH or similar
      // depending on validation order — pin the family rather than the exact
      // code so a future validation reorder doesn't break this contract pin.
      expect(typeof result.code).toBe('string');
      expect(String(result.code).length).toBeGreaterThan(0);
    });
  });

  describe('latestPlanReviewSummary provenance (F1 wiring)', () => {
    const NOW = '2026-01-01T00:00:00.000Z';

    async function dependencies() {
      const assuranceMod = await import('./review/assurance.js');
      const findingsHashMod = await import('./review/findings-hash.js');
      const planResponseMod = await import('./tools/plan-response.js');
      return {
        artifactReviewSubjectScope: assuranceMod.artifactReviewSubjectScope,
        buildInvocationEvidence: assuranceMod.buildInvocationEvidence,
        createReviewObligation: assuranceMod.createReviewObligation,
        REVIEW_CRITERIA_VERSION: assuranceMod.REVIEW_CRITERIA_VERSION,
        REVIEW_MANDATE_DIGEST: assuranceMod.REVIEW_MANDATE_DIGEST,
        hashFindings: findingsHashMod.hashFindings,
        latestPlanReviewSummary: planResponseMod.latestPlanReviewSummary,
      };
    }

    type Dependencies = Awaited<ReturnType<typeof dependencies>>;

    function producerObligation(deps: Dependencies, subjectDigest: string) {
      return deps.createReviewObligation({
        obligationType: 'plan',
        iteration: 0,
        planVersion: 1,
        now: NOW,
        subjectDigest,
        reviewSubjectScope: deps.artifactReviewSubjectScope(
          'plan',
          '## Approach\nBody',
          subjectDigest,
        ),
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      });
    }

    function findingsFor(
      deps: Dependencies,
      obligation: ReturnType<Dependencies['createReviewObligation']>,
    ) {
      return {
        iteration: 0,
        planVersion: 1,
        reviewMode: 'subagent',
        overallVerdict: 'changes_requested',
        blockingIssues: [],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
        reviewedBy: { sessionId: 'ses-child' },
        reviewedAt: NOW,
        attestation: {
          mandateDigest: deps.REVIEW_MANDATE_DIGEST,
          criteriaVersion: deps.REVIEW_CRITERIA_VERSION,
          toolObligationId: obligation.obligationId,
          iteration: 0,
          planVersion: 1,
          reviewedBy: 'flowguard-reviewer',
        },
      } as ReviewFindings;
    }

    function invocationFor(
      deps: Dependencies,
      obligation: ReturnType<Dependencies['createReviewObligation']>,
      findings: ReviewFindings,
      consumedBy: string | null = null,
    ) {
      return {
        ...deps.buildInvocationEvidence({
          obligationId: obligation.obligationId,
          obligationType: 'plan',
          mandateDigest: deps.REVIEW_MANDATE_DIGEST,
          criteriaVersion: deps.REVIEW_CRITERIA_VERSION,
          parentSessionId: 'ses-parent',
          childSessionId: 'ses-child',
          invocationMode: 'host_subagent_task',
          hostVisible: true,
          promptHash: 'sha256-prompt',
          findingsHash: deps.hashFindings(findings),
          invokedAt: NOW,
          source: 'host-orchestrated',
        }),
        consumedByObligationId: consumedBy,
      };
    }

    it('projects the producer identity for evidence-bound findings (incl. own consumption)', async () => {
      const deps = await dependencies();
      const obligation = producerObligation(deps, 'plan-digest-reviewed');
      const findings = findingsFor(deps, obligation);
      const assuranceState = {
        assuranceSchemaVersion: 'review-assurance.v5' as const,
        obligations: [obligation],
        invocations: [invocationFor(deps, obligation, findings, obligation.obligationId)],
        attempts: [],
      };
      const summary = deps.latestPlanReviewSummary(assuranceState, findings, 1);
      expect(summary.reviewedDigest).toBe('plan-digest-reviewed');
      expect(summary.reviewedObligationId).toBe(obligation.obligationId);
      expect(summary.reviewerIteration).toBe(0);
      expect(summary.reviewedPlanVersion).toBe(1);
    });

    it('omits the identity when the attested obligation has no evidence binding (unsafe nextObligation case)', async () => {
      const deps = await dependencies();
      const obligation = producerObligation(deps, 'plan-digest-unbound');
      const findings = findingsFor(deps, obligation);
      const assuranceState = {
        assuranceSchemaVersion: 'review-assurance.v5' as const,
        obligations: [obligation],
        invocations: [],
        attempts: [],
      };
      const summary = deps.latestPlanReviewSummary(assuranceState, findings, 1);
      expect(summary.reviewedDigest).toBeUndefined();
      expect(summary.reviewedObligationId).toBeUndefined();
    });
  });

  describe('assertTestConfigDir (test safety guard)', () => {
    it('HAPPY: passes when OPENCODE_CONFIG_DIR is set to a temp directory', async () => {
      const ws = await createTestWorkspace();
      expect(() => assertTestConfigDir()).not.toThrow();
      await ws.cleanup();
    });

    it('BAD: throws when OPENCODE_CONFIG_DIR is not set', () => {
      const cleanup = withTestEnv({ OPENCODE_CONFIG_DIR: undefined });
      try {
        expect(() => assertTestConfigDir()).toThrow('Unsafe OPENCODE_CONFIG_DIR');
      } finally {
        cleanup();
      }
    });

    it('BAD: throws when OPENCODE_CONFIG_DIR points to non-temp directory', () => {
      const nonTempPath = path.join(os.homedir(), '.config', 'opencode');
      const cleanup = withTestEnv({ OPENCODE_CONFIG_DIR: nonTempPath });
      try {
        expect(() => assertTestConfigDir()).toThrow('Unsafe OPENCODE_CONFIG_DIR');
      } finally {
        cleanup();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // BUG-21: Null-tolerant mode detection (defense-in-depth for Fixes D/E/F)
  //
  // Post-Zod, null values should never reach execute(). These tests verify that
  // IF null somehow leaks through (schema change, framework bypass), the mode
  // detection logic treats null as "field absent" — not as "field present".
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('BUG-21: null-tolerant mode detection (plan tool)', () => {
    it('HAPPY: reviewVerdict=null + planText → Mode A (plan submitted)', async () => {
      await hydrateAndTicket();
      // Simulate a Zod bypass: args.reviewVerdict is null
      const raw = await plan.execute(
        {
          planText: '## Plan\n1. Fix auth',
          reviewVerdict: null,
          targetPaths: ['docs/test.md'],
        } as any,
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).not.toBe(true);
      expect(result.status).toContain('Plan submitted');
    });

    it('HAPPY: reviewFindings=null + planText → Mode A (not PLAN_SUBMISSION_MIXED_INPUTS)', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute(
        {
          planText: '## Plan\n1. Fix auth',
          reviewFindings: null,
          targetPaths: ['docs/test.md'],
        } as any,
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).not.toBe(true);
      expect(result.status).toContain('Plan submitted');
    });

    it('CORNER: both reviewVerdict=null + reviewFindings=null + planText → Mode A', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute(
        {
          planText: '## Plan\n1. Fix auth',
          reviewVerdict: null,
          reviewFindings: null,
          targetPaths: ['docs/test.md'],
        } as any,
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).not.toBe(true);
      expect(result.status).toContain('Plan submitted');
    });

    it('BAD: reviewVerdict=null + no planText → EMPTY_PLAN (not verdict path)', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute({ reviewVerdict: null } as any, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('EMPTY_PLAN');
    });

    it('EDGE: reviewVerdict="" (empty string) + planText → Mode A', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute(
        { planText: '## Plan\n1. Fix', reviewVerdict: '', targetPaths: ['docs/test.md'] } as any,
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).not.toBe(true);
      expect(result.status).toContain('Plan submitted');
    });
  });
});
