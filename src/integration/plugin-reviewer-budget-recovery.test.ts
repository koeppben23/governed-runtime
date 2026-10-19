/**
 * @module integration/plugin-reviewer-budget-recovery.test
 * @description End-to-end recovery after the reviewer re-arm budget is
 * exhausted (GUI run 2026-10-19: two token-truncated plan reviews).
 *
 * Real `/plan` submission, real native reviewer dispatch through the plugin
 * hooks, real truncated child transcript. Proves on the PERSISTED authority:
 * - the closure output never claims a fresh attempt was authorized;
 * - the re-armed attempt's prompt reports an unfinished task, not rejected
 *   structured output;
 * - neither a further reviewer Task nor `retry_transport` can mint an attempt
 *   on the closed obligation (no budget is obtained twice), and the transport
 *   retry names the executable recovery instead of a restore/abort dead end;
 * - re-submitting the UNCHANGED plan is the legal path: it mints exactly one
 *   fresh obligation with the regular budget, leaves the closed obligation
 *   untouched, and authorizes a reviewer Task again.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { FlowGuardAuditPlugin } from './plugin.js';
import {
  createBootableHostClient,
  createTestWorkspace,
  createToolContext,
  parseToolResult,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { hydrate, plan, ticket } from './tools/index.js';
import { readState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { verifyChain } from '../audit/integrity.js';
import { _resetAgentResolutionCache } from './review/dispatch/agent-resolution.js';

vi.mock('./git-control-plane', async (importOriginal) => {
  const { gitControlPlaneAdapterMock } = await import('./adapter-mock-test-helpers.js');
  return gitControlPlaneAdapterMock(
    await importOriginal<typeof import('./git-control-plane.js')>(),
  );
});

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  const { GIT_MOCK_DEFAULTS } = await import('./test-helpers.js');
  return {
    ...original,
    isGitRepo: vi.fn().mockResolvedValue(true),
    isGitRepoStrict: vi.fn().mockResolvedValue(true),
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
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    }),
  };
});

const PLAN_TEXT =
  '## Objective\nFix the update path\n## Approach\nGuard the lookup\n## Steps\n1. guard\n' +
  '## Files to Modify\ntest.ts\n## Edge Cases\n1. missing id\n## Validation Criteria\n1. pass\n' +
  '## Verification Plan\n1. test';

const OCT19_TRUNCATED = JSON.parse(
  readFileSync(
    new URL(
      './review/dispatch/__fixtures__/reviewer-plan-2026-10-19-pre-followup-redacted.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as unknown;

let ws: TestWorkspace;
let ctx: TestToolContext;

beforeEach(async () => {
  _resetAgentResolutionCache();
  ws = await createTestWorkspace();
  ctx = createToolContext({ worktree: ws.tmpDir, directory: ws.tmpDir });
});

afterEach(async () => {
  vi.clearAllMocks();
  await ws.cleanup();
});

async function sessionDir(): Promise<string> {
  const { computeFingerprint, sessionDir: resolve } =
    await import('../adapters/workspace/index.js');
  return resolve((await computeFingerprint(ws.tmpDir)).fingerprint, ctx.sessionID);
}

async function bootPlugin(structuredPrompt: ReturnType<typeof vi.fn>) {
  return FlowGuardAuditPlugin({
    project: {} as unknown,
    client: createBootableHostClient({
      app: { agents: vi.fn(async () => ({ data: [{ id: 'flowguard-reviewer' }] })) },
      session: { prompt: structuredPrompt, messages: vi.fn(async () => OCT19_TRUNCATED) },
    }),
    $: {} as unknown,
    directory: ws.tmpDir,
    worktree: ws.tmpDir,
    serverUrl: new URL('http://localhost:3000'),
  } as unknown as Parameters<typeof FlowGuardAuditPlugin>[0]);
}

type Hooks = Awaited<ReturnType<typeof FlowGuardAuditPlugin>>;

/** Route a real flowguard_plan result through the plugin after-hook. */
async function registerPlanResponse(hooks: Hooks, raw: string, callID: string): Promise<void> {
  await hooks['tool.execute.after']!(
    { tool: 'flowguard_plan', sessionID: ctx.sessionID, callID, args: {} },
    { title: 'plan', output: raw, metadata: {} },
  );
}

async function runReviewerTask(hooks: Hooks, callID: string) {
  const before: { args: Record<string, unknown> } = {
    args: { subagent_type: 'flowguard-reviewer', prompt: 'agent-authored prompt' },
  };
  await hooks['tool.execute.before']!({ tool: 'task', sessionID: ctx.sessionID, callID }, before);
  const after = {
    title: 'task',
    output: 'Free-form reviewer transcript text is not findings authority.',
    metadata: { sessionId: `child-${callID}` },
  };
  await hooks['tool.execute.after']!(
    {
      tool: 'task',
      sessionID: ctx.sessionID,
      callID,
      args: { subagent_type: 'flowguard-reviewer' },
    },
    after,
  );
  return {
    prompt: String(before.args.prompt),
    result: JSON.parse(String(after.output)) as Record<string, unknown>,
  };
}

/**
 * Real `/plan` submission, then truncated reviewer Tasks until FlowGuard stops
 * re-arming (bounded): the 2026-10-19 GUI sequence up to the budget closure.
 */
async function driveToBudgetClosure() {
  await hydrate.execute({ policyMode: 'solo' }, ctx);
  await ticket.execute({ text: 'Fix the update path', source: 'user' }, ctx);
  const submittedRaw = String(
    await plan.execute({ planText: PLAN_TEXT, targetPaths: ['docs/test.md'] }, ctx),
  );
  const submitted = parseToolResult(submittedRaw);
  const closedObligationId = (submitted.reviewObligation as { obligationId: string }).obligationId;

  const structuredPrompt = vi.fn(async () => ({ data: {} }));
  const hooks = await bootPlugin(structuredPrompt);
  await registerPlanResponse(hooks, submittedRaw, 'plan-1');

  const runs: Awaited<ReturnType<typeof runReviewerTask>>[] = [];
  for (let i = 1; i <= 5; i++) {
    const run = await runReviewerTask(hooks, `task-${i}`);
    runs.push(run);
    if (run.result.reviewRetry === undefined) break;
    expect(run.result.reviewRetry).toMatchObject({
      code: 'REVIEWER_OUTPUT_TRUNCATED',
      retryable: true,
    });
  }
  return { closedObligationId, structuredPrompt, hooks, runs };
}

describe('reviewer re-arm budget exhaustion: executable recovery', () => {
  it('closes without claiming a fresh attempt, and a resubmitted unchanged plan is the only legal path', async () => {
    const { closedObligationId, structuredPrompt, hooks, runs } = await driveToBudgetClosure();
    // At least one re-arm happened, so the retry prompt is really exercised.
    expect(runs.length).toBeGreaterThan(1);
    const closure = runs.at(-1)!.result;
    expect(closure).toMatchObject({ error: true, code: 'REVIEWER_OUTPUT_TRUNCATED' });
    expect(closure.reviewRetry).toBeUndefined();
    // The truncated reviews were never serialized.
    expect(structuredPrompt).not.toHaveBeenCalled();

    // BAD: the closure output must not claim a re-armed attempt.
    const recovery = (closure.recovery as string[]).join('\n');
    expect(recovery).not.toMatch(/re-armed automatically/i);
    expect(recovery).not.toContain('Invoke the reviewer Task again');
    expect(recovery).toContain('do not invoke the reviewer Task again');
    expect(String(closure.message)).toContain('no fresh reviewer attempt was authorized');

    // Every re-armed prompt reports an unfinished task, never rejected output.
    for (const run of runs.slice(1)) {
      expect(run.prompt).toContain('Prior Reviewer Task Not Completed');
      expect(run.prompt).toContain('- Code: REVIEWER_OUTPUT_TRUNCATED');
      expect(run.prompt).not.toContain('Prior Output Rejected');
    }

    const sessDir = await sessionDir();
    const closed = (await readState(sessDir))!;
    const closedObligation = closed.reviewAssurance!.obligations.find(
      (o) => o.obligationId === closedObligationId,
    )!;
    expect(closedObligation.status).toBe('blocked');
    const closedAttempts = closed.reviewAssurance!.attempts.filter(
      (a) => a.obligationId === closedObligationId,
    );
    expect(closedAttempts).toHaveLength(runs.length);
    expect(closedAttempts).toHaveLength(closedObligation.maxReviewerAttempts + 1);
    expect(closedAttempts.every((a) => a.status === 'stale')).toBe(true);

    // BAD: a further reviewer Task cannot be released for the closed obligation.
    await expect(runReviewerTask(hooks, 'task-after-closure')).rejects.toThrow();

    // BAD: retry_transport cannot reopen it and names the executable recovery.
    const transport = parseToolResult(
      await plan.execute({ reviewRecovery: 'retry_transport' }, ctx),
    );
    expect(transport).toMatchObject({ error: true, code: 'REVIEW_ATTEMPT_UNAVAILABLE' });
    expect(String(transport.message)).toContain('closed');
    expect(String(transport.message)).toContain('submit the artifact again');
    expect(String(transport.message)).not.toContain('restored or the session aborted');
    const afterRetries = (await readState(sessDir))!;
    expect(afterRetries.reviewAssurance).toEqual(closed.reviewAssurance);

    // HAPPY: the unchanged plan, resubmitted, mints exactly one fresh obligation.
    const resubmittedRaw = String(
      await plan.execute({ planText: PLAN_TEXT, targetPaths: ['docs/test.md'] }, ctx),
    );
    const resubmitted = parseToolResult(resubmittedRaw);
    expect(resubmitted.error).not.toBe(true);
    const fresh = resubmitted.reviewObligation as { obligationId: string; planVersion: number };
    expect(fresh.obligationId).not.toBe(closedObligationId);

    const recovered = (await readState(sessDir))!;
    const planObligations = recovered.reviewAssurance!.obligations.filter(
      (o) => o.obligationType === 'plan',
    );
    expect(planObligations).toHaveLength(2);
    // EDGE: the closed obligation and its spent attempts are untouched.
    expect(planObligations.find((o) => o.obligationId === closedObligationId)).toEqual(
      closedObligation,
    );
    expect(
      recovered.reviewAssurance!.attempts.filter((a) => a.obligationId === closedObligationId),
    ).toEqual(closedAttempts);
    // The fresh obligation carries the regular budget, not an inherited or doubled one.
    const freshObligation = planObligations.find((o) => o.obligationId === fresh.obligationId)!;
    expect(freshObligation.status).toBe('pending');
    expect(freshObligation.maxReviewerAttempts).toBe(closedObligation.maxReviewerAttempts);
    const freshAttempts = recovered.reviewAssurance!.attempts.filter(
      (a) => a.obligationId === fresh.obligationId,
    );
    expect(freshAttempts).toHaveLength(1);
    expect(freshAttempts[0]?.status).toBe('created');

    // The recovered path is a legal reviewer dispatch again.
    await registerPlanResponse(hooks, resubmittedRaw, 'plan-2');
    const recoveredRun = await runReviewerTask(hooks, 'task-recovered');
    expect(recoveredRun.prompt).not.toContain('Prior Reviewer Task Not Completed');
    const dispatched = (await readState(sessDir))!.reviewAssurance!.dispatches.filter(
      (d) => d.obligationId === fresh.obligationId,
    );
    expect(dispatched).toHaveLength(1);
  });

  it('keeps the closure audit intent durable and chains it at the next mutating FlowGuard tool', async () => {
    const { closedObligationId, hooks } = await driveToBudgetClosure();
    const sessDir = await sessionDir();
    const isClosure = (event: string, detail: unknown): boolean =>
      event === 'review:obligation_blocked' &&
      (detail as { obligationId?: unknown } | undefined)?.obligationId === closedObligationId;

    // The semantic closure intent is committed with the blocked obligation.
    const closed = (await readState(sessDir))!;
    const intents = closed.pendingAuditOperations.filter(
      (op) => op.kind === 'semantic' && isClosure(op.semantic.event, op.semantic.detail),
    );
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(intent.status).not.toBe('reconciled');
    expect(intent.kind === 'semantic' && intent.semantic.detail).toMatchObject({
      blockedCode: 'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
      captureCode: 'REVIEWER_OUTPUT_TRUNCATED',
    });
    // Outbox latency: nothing has drained it yet, so a raw trail export at this
    // point lacks the event (the GUI-run observation).
    const trailAtClosure = await readAuditTrail(sessDir);
    expect(trailAtClosure.filter((e) => isClosure(e.event, e.detail))).toHaveLength(0);

    // A denied host mutation appends its own denial but neither drains nor
    // drops the pending intent.
    await expect(
      hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: ctx.sessionID, callID: 'bash-denied' },
        { args: { command: 'echo blocked' } },
      ),
    ).rejects.toThrow();
    const afterDenial = (await readState(sessDir))!;
    expect(
      afterDenial.pendingAuditOperations.find((op) => op.operationId === intent.operationId)
        ?.status,
    ).toBe(intent.status);
    expect(
      (await readAuditTrail(sessDir)).filter((e) => e.event === 'enforcement:denied').length,
    ).toBeGreaterThan(0);

    // The next mutating FlowGuard tool reconciles the outbox before it runs.
    await hooks['tool.execute.before']!(
      { tool: 'flowguard_plan', sessionID: ctx.sessionID, callID: 'plan-resubmit' },
      { args: { planText: PLAN_TEXT, targetPaths: ['docs/test.md'] } },
    );
    const trail = await readAuditTrail(sessDir);
    const chained = trail.filter((e) => isClosure(e.event, e.detail));
    expect(chained).toHaveLength(1);
    expect(chained[0]!.detail).toMatchObject({
      obligationId: closedObligationId,
      blockedCode: 'REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE',
      captureCode: 'REVIEWER_OUTPUT_TRUNCATED',
    });
    expect(verifyChain(trail as unknown as Record<string, unknown>[]).valid).toBe(true);
    expect(
      (await readState(sessDir))!.pendingAuditOperations.find(
        (op) => op.operationId === intent.operationId,
      )?.status,
    ).toBe('reconciled');
  });
});
