/**
 * @module integration/auto-validation.test
 * @description Focused integration coverage for automatic validation.
 *
 * The canonical workflow runs the active checks in-flow when a session enters
 * VALIDATION (human approval) or IMPL_VALIDATION (after /implement). These tests
 * prove the automatic chain end to end, without any user-typed /run_check call:
 *
 * - team plan approval: decision approve → checks run → persisted evidence →
 *   IMPLEMENTATION
 * - team implementation: /implement → post-implementation checks → IMPL_REVIEW
 *   with an activated review obligation and dispatch instruction
 * - check failure: VALIDATION → PLAN and IMPL_VALIDATION → IMPLEMENTATION with
 *   the failure evidence persisted
 * - execution error: the validation phase is kept and the error response is
 *   surfaced (no silent advance)
 * - solo: plan convergence auto-approves into VALIDATION and the checks run
 * - no active checks: no automatic execution, vacuous-advance semantics kept
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  withStrictReviewFindings,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { status, hydrate, ticket, plan, decision, implement } from './tools/index.js';
import { readState, statePath, writeState } from '../adapters/persistence.js';
import { resumePendingSystemWork, runActiveChecksAutomatically } from './tools/auto-validation.js';
import * as fs from 'node:fs/promises';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { clearUserDecisionIntents, recordUserDecisionIntent } from './user-decision-intent.js';
import type { ToolDefinition } from './tools/helpers.js';
import type { VerificationCandidateKind } from '../state/discovery-schemas.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    isGitRepo: vi.fn().mockResolvedValue(true),
    isGitRepoStrict: vi.fn().mockResolvedValue(true),
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
    headCommitFull: vi.fn().mockResolvedValue('d'.repeat(40)),
  };
});

vi.mock('../adapters/frozen-repository.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/frozen-repository.js')>();
  return {
    ...original,
    freezeRepositoryIdentity: vi.fn(() => ({
      kind: 'local' as const,
      rootCommitDigest: 'sha256:' + 'b'.repeat(64),
    })),
    freezeWorktreeCandidate: vi.fn().mockResolvedValue('c'.repeat(40)),
  };
});

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    }),
  };
});

// The automatic runner must never spawn real subprocesses in the temp worktree.
vi.mock('../verification/executor', () => ({
  executeCheck: vi.fn().mockImplementation(async (input: { kind: string; command: string }) => ({
    kind: input.kind,
    command: input.command,
    exitCode: 0,
    passed: true,
    executionMs: 100,
    outputDigest: 'a'.repeat(64),
    stdout: 'OK',
    stderr: '',
    timedOut: false,
    startedAt: new Date().toISOString(),
  })),
}));

const executorMock = await import('../verification/executor.js');
const actorMock = await import('../adapters/actor.js');

// ─── Setup ───────────────────────────────────────────────────────────────────

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
  clearUserDecisionIntents();
  vi.mocked(actorMock.resolveActor)
    .mockReset()
    .mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    });
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function callOk(
  tool: ToolDefinition,
  args: unknown,
  context: TestToolContext = ctx,
): Promise<Record<string, unknown>> {
  const finalArgs = await withStrictReviewFindings(await getSessDir(context), args);
  recordDecisionIntentForTool(tool, finalArgs, context);
  const result = parseToolResult(await tool.execute(finalArgs, context));
  if (result.error) {
    throw new Error(`Tool returned error: ${result.code} — ${result.message}`);
  }
  return result;
}

function recordDecisionIntentForTool(
  tool: ToolDefinition,
  args: unknown,
  context: TestToolContext = ctx,
): void {
  if (tool !== decision || typeof args !== 'object' || args === null) return;
  const verdict = (args as { verdict?: unknown }).verdict;
  if (verdict !== 'approve' && verdict !== 'changes_requested' && verdict !== 'reject') return;
  recordUserDecisionIntent({
    sessionId: context.sessionID,
    command: '/review-decision',
    expectedVerdict: verdict,
  });
}

async function getPhase(context: TestToolContext = ctx): Promise<string> {
  return (parseToolResult(await status.execute({}, context)).phase as string) ?? '';
}

async function getSessDir(context: TestToolContext = ctx): Promise<string> {
  const fp = await computeFingerprint(context.worktree);
  return resolveSessionDir(fp.fingerprint, context.sessionID);
}

function failingCheck(kind: VerificationCandidateKind) {
  return {
    kind,
    command: 'npx tsc --noEmit',
    exitCode: 1,
    passed: false,
    executionMs: 100,
    outputDigest: 'c'.repeat(64),
    stdout: 'src/main.ts: error TS2322',
    stderr: '',
    timedOut: false,
    startedAt: new Date().toISOString(),
  };
}

function timedOutCheck(kind: VerificationCandidateKind) {
  return {
    kind,
    command: 'npx tsc --noEmit',
    exitCode: 124,
    passed: false,
    executionMs: 60000,
    outputDigest: '0'.repeat(64),
    stdout: '',
    stderr: '',
    timedOut: true,
    startedAt: new Date().toISOString(),
  };
}

/** Reach PLAN_REVIEW in team mode (the plan review loop must converge first). */
async function reachTeamPlanReview(context: TestToolContext = ctx): Promise<void> {
  await callOk(hydrate, { policyMode: 'team', profileId: 'baseline' }, context);
  await callOk(ticket, { text: 'Auto validation task', source: 'user' }, context);
  await callOk(
    plan,
    {
      planText: '## Plan\n1. Apply the fix',
      targetPaths: ['docs/test.md'],
    },
    context,
  );
  for (let i = 0; i < 5 && (await getPhase(context)) !== 'PLAN_REVIEW'; i++) {
    await callOk(plan, { reviewVerdict: 'accept' }, context);
  }
  expect(await getPhase(context)).toBe('PLAN_REVIEW');
}

/** Reach IMPLEMENTATION in solo mode with the automatic baseline checks passed. */
async function reachSoloImplementation(): Promise<void> {
  await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
  await callOk(ticket, { text: 'Auto validation task', source: 'user' });
  await callOk(plan, {
    planText: '## Plan\n1. Apply the fix',
    targetPaths: ['docs/test.md'],
  });
  await callOk(plan, { reviewVerdict: 'accept' });
  expect(await getPhase()).toBe('IMPLEMENTATION');
}

// ─── HAPPY ───────────────────────────────────────────────────────────────────

describe('automatic validation', () => {
  describe('HAPPY', () => {
    it('team plan approval runs every active check automatically and persists the evidence', async () => {
      await reachTeamPlanReview();
      vi.mocked(executorMock.executeCheck).mockClear();

      const result = await callOk(decision, { verdict: 'approve', rationale: 'Approved' });

      // The decision response is superseded by the final automatic run_check
      // response: the approval crossed VALIDATION into IMPLEMENTATION.
      expect(result.phase).toBe('IMPLEMENTATION');
      expect(result.evidence).toBeDefined();

      const state = await readState(await getSessDir());
      expect(state!.phase).toBe('IMPLEMENTATION');
      expect(state!.validation.map((entry) => entry.checkId)).toEqual(state!.activeChecks);
      expect(state!.validation.every((entry) => entry.passed)).toBe(true);
      // Each active kind was executed exactly once by the automatic runner — no
      // explicit run_check call happens in this test.
      expect(vi.mocked(executorMock.executeCheck).mock.calls).toHaveLength(
        state!.activeChecks.length,
      );
    });

    it('team /implement runs the post-implementation checks automatically and activates the review obligation', async () => {
      await reachTeamPlanReview();
      await callOk(decision, { verdict: 'approve', rationale: 'Approved' });
      vi.mocked(executorMock.executeCheck).mockClear();

      const result = await callOk(implement, {});

      // IMPL_VALIDATION was crossed automatically; the response is the final
      // post-implementation run_check response at IMPL_REVIEW.
      expect(result.phase).toBe('IMPL_REVIEW');
      expect(result.reviewObligation).toBeDefined();
      expect(result.reviewInvocation).toBeDefined();
      expect(result.reviewDispatch).toEqual({ required: true });

      const state = await readState(await getSessDir());
      expect(state!.phase).toBe('IMPL_REVIEW');
      expect(state!.implValidation.map((entry) => entry.checkId)).toEqual(state!.activeChecks);
      expect(state!.implValidation.every((entry) => entry.passed)).toBe(true);
      expect(vi.mocked(executorMock.executeCheck).mock.calls).toHaveLength(
        state!.activeChecks.length,
      );
      const implementObligations = state!.reviewAssurance!.obligations.filter(
        (obligation) => obligation.obligationType === 'implement',
      );
      expect(implementObligations).toHaveLength(1);
      expect(implementObligations[0]!.status).not.toBe('consumed');
    });
  });

  // ─── BAD ───────────────────────────────────────────────────────────────────

  describe('BAD', () => {
    it('baseline check failure routes VALIDATION → PLAN with the failure evidence persisted', async () => {
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      await callOk(ticket, { text: 'Failing check task', source: 'user' });
      await callOk(plan, {
        planText: '## Plan\n1. Apply the fix',
        targetPaths: ['docs/test.md'],
      });

      vi.mocked(executorMock.executeCheck).mockResolvedValueOnce(failingCheck('typecheck'));
      const result = await callOk(plan, { reviewVerdict: 'accept' });

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PLAN');

      const state = await readState(await getSessDir());
      expect(state!.phase).toBe('PLAN');
      expect(state!.validation[0]).toMatchObject({
        checkId: 'typecheck',
        passed: false,
        exitCode: 1,
        outputDigest: 'c'.repeat(64),
      });
    });

    it('post-implementation check failure routes IMPL_VALIDATION → IMPLEMENTATION with the failure evidence persisted', async () => {
      await reachSoloImplementation();

      vi.mocked(executorMock.executeCheck).mockResolvedValueOnce(failingCheck('typecheck'));
      const result = await callOk(implement, {});

      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('IMPLEMENTATION');

      const state = await readState(await getSessDir());
      expect(state!.phase).toBe('IMPLEMENTATION');
      // The delivered code is wrong, not the plan: implementation evidence is
      // cleared for a re-record while the failure stays on the ledger.
      expect(state!.implementation).toBeNull();
      expect(state!.implValidation[0]).toMatchObject({
        checkId: 'typecheck',
        passed: false,
        exitCode: 1,
      });
    });
  });

  // ─── CORNER ────────────────────────────────────────────────────────────────

  describe('CORNER', () => {
    it('an execution error keeps the validation phase and surfaces the error response', async () => {
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      await callOk(ticket, { text: 'Execution error task', source: 'user' });
      await callOk(plan, {
        planText: '## Plan\n1. Apply the fix',
        targetPaths: ['docs/test.md'],
      });

      vi.mocked(executorMock.executeCheck).mockResolvedValueOnce(timedOutCheck('typecheck'));
      const result = await callOk(plan, { reviewVerdict: 'accept' });

      // CHECK_ERRORED is a transient/infra condition, not a plan deficiency: no
      // silent advance and no route back to PLAN.
      expect(result.phase).toBe('VALIDATION');
      const evidence = result.evidence as Record<string, unknown>;
      expect(evidence.timedOut).toBe(true);
      expect(evidence.passed).toBe(false);

      const state = await readState(await getSessDir());
      expect(state!.phase).toBe('VALIDATION');
      expect(state!.validation[0]).toMatchObject({ checkId: 'typecheck', passed: false });
      // A technical outcome must NOT consume the pending marker: the phase is
      // still validation, so the retry authority stays durable.
      expect(state!.pendingSystemWork).not.toBeNull();
      expect(state!.pendingSystemWork?.kind).toBe('validation');

      // VALIDATION dead-state regression guard: while the session waits for a
      // retry, the focused status projection must still expose the
      // verification-check fields the validation gate depends on.
      const focused = parseToolResult(await status.execute({ whyBlocked: true }, ctx));
      expect((focused.activeChecks as unknown[]).length).toBeGreaterThan(0);
      expect(Array.isArray(focused.verificationCandidates)).toBe(true);
      expect((focused.remainingChecks as unknown[]).length).toBeGreaterThan(0);
    });

    it('a blocked /plan call at VALIDATION does not trigger the automatic runner', async () => {
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      await callOk(ticket, { text: 'Blocked plan task', source: 'user' });
      await callOk(plan, {
        planText: '## Plan\n1. Apply the fix',
        targetPaths: ['docs/test.md'],
      });

      // Keep the session in VALIDATION with an execution error, then call /plan
      // again: the command is inadmissible there and the blocked response must
      // not re-run the checks.
      vi.mocked(executorMock.executeCheck).mockResolvedValueOnce(timedOutCheck('typecheck'));
      await callOk(plan, { reviewVerdict: 'accept' });
      expect(await getPhase()).toBe('VALIDATION');
      vi.mocked(executorMock.executeCheck).mockClear();

      const blocked = parseToolResult(
        await plan.execute({ planText: '## Plan v2', targetPaths: ['docs/test.md'] }, ctx),
      );
      expect(blocked.error).toBe(true);
      expect(blocked.code).toBe('COMMAND_NOT_ALLOWED');
      expect(vi.mocked(executorMock.executeCheck)).not.toHaveBeenCalled();
      expect(await getPhase()).toBe('VALIDATION');
    });

    it('a blocked /implement call at IMPL_VALIDATION does not re-run the automatic checks', async () => {
      await reachSoloImplementation();

      vi.mocked(executorMock.executeCheck).mockResolvedValueOnce(timedOutCheck('typecheck'));
      await callOk(implement, {});
      expect(await getPhase()).toBe('IMPL_VALIDATION');
      vi.mocked(executorMock.executeCheck).mockClear();

      const blocked = parseToolResult(await implement.execute({}, ctx));
      expect(blocked.error).toBe(true);
      expect(blocked.code).toBe('COMMAND_NOT_ALLOWED');
      expect(vi.mocked(executorMock.executeCheck)).not.toHaveBeenCalled();
      expect(await getPhase()).toBe('IMPL_VALIDATION');
    });

    it('no active checks preserves vacuous-advance semantics with no automatic execution', async () => {
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      await callOk(ticket, { text: 'No checks task', source: 'user' });
      await callOk(plan, {
        planText: '## Plan\n1. Apply the fix',
        targetPaths: ['docs/test.md'],
      });

      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      await writeState(sessDir, {
        ...state!,
        activeChecks: [],
        discoverySummary: null,
        detectedStack: null,
        policySnapshot: {
          ...state!.policySnapshot,
          validationEvidence: { enforcement: 'off', allowNoCommands: false },
        },
      });
      vi.mocked(executorMock.executeCheck).mockClear();

      const result = await callOk(plan, { reviewVerdict: 'accept' });

      expect(result.error).toBeUndefined();
      // Vacuous truth: the empty check list advances VALIDATION without running
      // anything and without a user-typed check step.
      expect(await getPhase()).toBe('IMPLEMENTATION');
      expect(vi.mocked(executorMock.executeCheck)).not.toHaveBeenCalled();
      const finalState = await readState(sessDir);
      expect(finalState!.validation).toHaveLength(0);
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────────────────────

  describe('EDGE', () => {
    it('solo plan convergence auto-approves into VALIDATION and runs the checks', async () => {
      await callOk(hydrate, { policyMode: 'solo', profileId: 'baseline' });
      await callOk(ticket, { text: 'Solo auto validation', source: 'user' });
      await callOk(plan, {
        planText: '## Plan\n1. Apply the fix',
        targetPaths: ['docs/test.md'],
      });
      vi.mocked(executorMock.executeCheck).mockClear();

      const result = await callOk(plan, { reviewVerdict: 'accept' });

      // Solo auto-approval crosses PLAN_REVIEW → VALIDATION inside the plan
      // call; the automatic runner then produced the validation evidence.
      expect(result.phase).toBe('IMPLEMENTATION');
      const state = await readState(await getSessDir());
      expect(state!.phase).toBe('IMPLEMENTATION');
      expect(state!.validation.map((entry) => entry.checkId)).toEqual(state!.activeChecks);
      expect(state!.validation.every((entry) => entry.passed)).toBe(true);
      expect(vi.mocked(executorMock.executeCheck).mock.calls).toHaveLength(
        state!.activeChecks.length,
      );
    });

    it('validates two sessions concurrently instead of blocking process-wide', async () => {
      const wsB = await createTestWorkspace();
      const ctxB = createToolContext({
        worktree: wsB.tmpDir,
        directory: wsB.tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      try {
        await reachTeamPlanReview();
        await reachTeamPlanReview(ctxB);

        // Hold the first executor call open so both sessions overlap inside
        // the automatic runner.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const defaultExecuteCheck = vi.mocked(executorMock.executeCheck).getMockImplementation();
        expect(defaultExecuteCheck).toBeDefined();
        vi.mocked(executorMock.executeCheck).mockImplementationOnce(async (input) => {
          await gate;
          return defaultExecuteCheck!(input);
        });

        recordUserDecisionIntent({
          sessionId: ctx.sessionID,
          command: '/approve',
          expectedVerdict: 'approve',
        });
        recordUserDecisionIntent({
          sessionId: ctxB.sessionID,
          command: '/approve',
          expectedVerdict: 'approve',
        });
        const pendingA = decision.execute({ verdict: 'approve', rationale: 'ok' }, ctx);
        const pendingB = decision.execute({ verdict: 'approve', rationale: 'ok' }, ctxB);

        // Give session A time to enter the runner and block on the gate.
        await new Promise((resolve) => setTimeout(resolve, 50));
        release();
        const [rawA, rawB] = await Promise.all([pendingA, pendingB]);

        // Session-scoped isolation: B must not have been suppressed by A's
        // in-flight validation.
        expect(parseToolResult(rawA).phase).toBe('IMPLEMENTATION');
        expect(parseToolResult(rawB).phase).toBe('IMPLEMENTATION');
        expect(await getPhase(ctx)).toBe('IMPLEMENTATION');
        expect(await getPhase(ctxB)).toBe('IMPLEMENTATION');
        const stateA = await readState(await getSessDir(ctx));
        const stateB = await readState(await getSessDir(ctxB));
        expect(stateA!.validation).toHaveLength(stateA!.activeChecks.length);
        expect(stateB!.validation).toHaveLength(stateB!.activeChecks.length);
      } finally {
        await wsB.cleanup();
      }
    });

    it('resumes interrupted system work from the persisted marker', async () => {
      await reachTeamPlanReview();

      // Simulate a crash between the persisted approval and the automatic run:
      // the session sits in VALIDATION with the pending marker and no evidence.
      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      const requestedAt = new Date().toISOString();
      await writeState(sessDir, {
        ...state!,
        phase: 'VALIDATION',
        pendingSystemWork: { kind: 'validation', requestedAt, attempt: 0, retryAfter: null },
        validation: [],
      });
      vi.mocked(executorMock.executeCheck).mockClear();

      const resumed = await resumePendingSystemWork(ctx);

      expect(resumed).toMatchObject({ kind: 'completed', phase: 'IMPLEMENTATION' });
      expect(await getPhase()).toBe('IMPLEMENTATION');
      const finalState = await readState(sessDir);
      expect(finalState!.pendingSystemWork).toBeNull();
      expect(finalState!.validation).toHaveLength(finalState!.activeChecks.length);
      expect(finalState!.validation.every((entry) => entry.passed)).toBe(true);

      // One attempt per marker generation: a second resume of the same marker
      // (e.g. a duplicate idle event) does not re-run the checks.
      vi.mocked(executorMock.executeCheck).mockClear();
      const again = await resumePendingSystemWork(ctx);
      expect(again).toEqual({ kind: 'none' });
      expect(vi.mocked(executorMock.executeCheck)).not.toHaveBeenCalled();
    });

    it('a technical resume outcome keeps the marker pending and reports still_pending', async () => {
      await reachTeamPlanReview();

      const sessDir = await getSessDir();
      const state = await readState(sessDir);
      const requestedAt = new Date().toISOString();
      await writeState(sessDir, {
        ...state!,
        phase: 'VALIDATION',
        pendingSystemWork: { kind: 'validation', requestedAt, attempt: 0, retryAfter: null },
        validation: [],
      });
      vi.mocked(executorMock.executeCheck).mockResolvedValueOnce(timedOutCheck('typecheck'));

      const resumed = await resumePendingSystemWork(ctx);

      expect(resumed).toMatchObject({ kind: 'still_pending', phase: 'VALIDATION' });
      const finalState = await readState(sessDir);
      expect(finalState!.phase).toBe('VALIDATION');
      expect(finalState!.pendingSystemWork).not.toBeNull();
      // The operation records its attempt and a backoff window instead of
      // becoming an unretryable one-shot.
      expect(finalState!.pendingSystemWork!.attempt).toBeGreaterThanOrEqual(1);
      expect(finalState!.pendingSystemWork!.retryAfter).not.toBeNull();

      // While the backoff is active, a lifecycle event does not re-run checks.
      vi.mocked(executorMock.executeCheck).mockClear();
      const duringBackoff = await resumePendingSystemWork(ctx);
      expect(duringBackoff).toEqual({ kind: 'none' });
      expect(vi.mocked(executorMock.executeCheck)).not.toHaveBeenCalled();

      // After the backoff window elapses, the operation is retryable again.
      const afterBackoff = await readState(sessDir);
      await writeState(sessDir, {
        ...afterBackoff!,
        pendingSystemWork: {
          ...afterBackoff!.pendingSystemWork!,
          retryAfter: new Date(Date.now() - 1000).toISOString(),
        },
      });
      vi.mocked(executorMock.executeCheck).mockResolvedValueOnce(timedOutCheck('typecheck'));
      const retried = await resumePendingSystemWork(ctx);
      expect(retried).toMatchObject({ kind: 'still_pending', phase: 'VALIDATION' });
      expect(vi.mocked(executorMock.executeCheck)).toHaveBeenCalledTimes(1);
    });

    it('fails closed with a blocked resume outcome on an unreadable session state', async () => {
      await reachTeamPlanReview();
      const sessDir = await getSessDir();
      await fs.writeFile(statePath(sessDir), '{ this is not valid json', 'utf-8');

      const resumed = await resumePendingSystemWork(ctx);

      expect(resumed).toMatchObject({ kind: 'blocked', code: 'SYSTEM_WORK_STATE_UNREADABLE' });
      expect(JSON.parse(resumed.kind === 'blocked' ? resumed.response : '{}')).toMatchObject({
        error: true,
        code: 'SYSTEM_WORK_STATE_UNREADABLE',
      });
    });

    it('fails closed with SYSTEM_WORK_STATE_UNREADABLE on an unreadable session state', async () => {
      await reachTeamPlanReview();
      const sessDir = await getSessDir();
      await fs.writeFile(statePath(sessDir), '{ this is not valid json', 'utf-8');

      const result = JSON.parse((await runActiveChecksAutomatically(ctx))!);

      // Never a silent "do not run": an unreadable system-work session is a
      // typed fail-closed result.
      expect(result).toMatchObject({ error: true, code: 'SYSTEM_WORK_STATE_UNREADABLE' });
    });
  });
});
