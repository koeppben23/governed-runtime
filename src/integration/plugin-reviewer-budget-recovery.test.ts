/** Canonical budget closure + native V2 lock retention/audit integration.
 * Domain setup is not operator UI provenance; an SDK/command-like callback
 * cannot supply the missing V2 explicit recovery authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { FlowGuardAuditPlugin } from './plugin.js';
import {
  createTestWorkspace,
  createToolContext,
  parseToolResult,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { createReviewClient, createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import {
  createReviewRuntime,
  REVIEW_TEST_PROOF_GRAPH_AUTHORITIES,
} from './reviewer-capture-test-helpers.js';
import { hydrate, plan, ticket } from './tools/index.js';
import { readState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { verifyChain } from '../audit/integrity.js';
import {
  nativeReviewTaskBefore,
  nativeReviewTaskAfter,
} from './review/dispatch/native-task-review.js';
import { onFlowGuardToolAfter } from './review/enforcement/enforcement.js';
import { isTerminalPhase } from '../machine/topology.js';

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
vi.mock('../adapters/actor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/actor.js')>()),
  resolveActor: vi.fn().mockResolvedValue({
    id: 'test-operator',
    email: 'test@flowguard.dev',
    displayName: null,
    source: 'env',
    assurance: 'best_effort',
  }),
}));

const PLAN_TEXT =
  '## Objective\nFix the update path\n## Approach\nGuard the lookup\n## Steps\n1. guard\n## Files to Modify\ntest.ts\n## Edge Cases\n1. missing id\n## Validation Criteria\n1. pass\n## Verification Plan\n1. test';
const OCT19 = JSON.parse(
  readFileSync(
    new URL(
      './review/dispatch/__fixtures__/reviewer-plan-2026-10-19-pre-followup-redacted.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { data: unknown };
let ws: TestWorkspace;
let ctx: TestToolContext;
let dispose: (() => void | Promise<void>) | undefined;
beforeEach(async () => {
  ws = await createTestWorkspace();
  ctx = createToolContext({ worktree: ws.tmpDir, directory: ws.tmpDir });
});
afterEach(async () => {
  try {
    await dispose?.();
  } finally {
    dispose = undefined;
    vi.clearAllMocks();
    await ws.cleanup();
  }
});

async function driveToClosure() {
  await hydrate.execute({ policyMode: 'solo' }, ctx);
  await ticket.execute({ text: 'Fix the update path', source: 'user' }, ctx);
  const raw = String(
    await plan.execute({ planText: PLAN_TEXT, targetPaths: ['docs/test.md'] }, ctx),
  );
  const submitted = parseToolResult(raw);
  const obligationId = (submitted.reviewObligation as { obligationId: string }).obligationId;
  const serialization = vi.fn(async () => {
    throw new Error('Truncated reviews must not be serialized');
  });
  const client = createReviewClient({
    executeReviewerPrompt: serialization,
    readHistory: vi.fn(async () => OCT19.data),
  });
  const runtime = createReviewRuntime(ws.tmpDir, client);
  onFlowGuardToolAfter(runtime.ws.getEnforcementState(ctx.sessionID), 'flowguard_plan', {}, raw, {
    now: new Date().toISOString(),
    isTerminalPhase,
  });
  await nativeReviewTaskBefore(
    runtime,
    { tool: 'task', sessionID: ctx.sessionID, callID: 'review' },
    { args: { subagent_type: 'flowguard-reviewer', prompt: 'untrusted' } },
    async () => undefined,
    REVIEW_TEST_PROOF_GRAPH_AUTHORITIES,
  );
  const output = {
    title: '',
    output: 'not findings authority',
    metadata: { sessionId: 'child-review' },
  };
  await nativeReviewTaskAfter(
    runtime,
    {
      tool: 'task',
      sessionID: ctx.sessionID,
      callID: 'review',
      args: { subagent_type: 'flowguard-reviewer' },
    },
    output,
  );
  const authority = await runtime.ws.resolveSessionAuthority(ctx.sessionID);
  if (authority.status !== 'resolved') throw new Error('Expected bound test authority');
  const host = createV2Host(ws.tmpDir);
  await host.seedActive(ctx.sessionID, authority.state.policySnapshot.hash);
  dispose = (await FlowGuardAuditPlugin.setup(host.ctx)) || undefined;
  return {
    host,
    runtime,
    sessDir: authority.sessDir,
    obligationId,
    serialization,
    closure: JSON.parse(output.output) as Record<string, unknown>,
  };
}

describe('canonical reviewer closure and unverified V2 recovery boundary', () => {
  it('closes terminally without granting another budget and never accepts command-like recovery claims', async () => {
    const h = await driveToClosure();
    expect(h.closure).toMatchObject({ error: true, code: 'REVIEWER_OUTPUT_TRUNCATED' });
    expect(h.closure.reviewRetry).toBeUndefined();
    expect(h.serialization).not.toHaveBeenCalled();
    const recovery = (h.closure.recovery as string[]).join('\n');
    expect(recovery).not.toMatch(/re-armed automatically/i);
    expect(recovery).toContain('Do not invoke the reviewer Task again');
    expect(recovery).toContain('new explicit review command');
    const closed = (await readState(h.sessDir))!;
    expect(
      closed.reviewAssurance!.obligations.find((item) => item.obligationId === h.obligationId),
    ).toMatchObject({ status: 'blocked', blockedCode: 'REVIEWER_OUTPUT_TRUNCATED' });
    const attempts = closed.reviewAssurance!.attempts.filter(
      (item) => item.obligationId === h.obligationId,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('stale');
    expect(closed.reviewAssurance!.capacityLock).toMatchObject({
      code: 'REVIEWER_OUTPUT_TRUNCATED',
      obligationId: h.obligationId,
    });
    const retry = parseToolResult(await plan.execute({ reviewRecovery: 'retry_transport' }, ctx));
    expect(retry).toMatchObject({ error: true, code: 'REVIEW_ATTEMPT_UNAVAILABLE' });
    expect(String(retry.message)).toContain('closed');
    for (const command of ['/status', '/plan', '/implement']) {
      await h.host.request({
        sessionID: ctx.sessionID,
        agent: 'build',
        options: { command, origin: 'human' },
      });
      await expect(
        h.host.before(
          v2ToolEvent({
            sessionID: ctx.sessionID,
            tool: 'flowguard_plan',
            input: { planText: PLAN_TEXT, command, origin: 'human' },
          }),
        ),
      ).rejects.toThrow('REVIEW_CAPACITY_REQUIRES_NEW_USER_COMMAND');
      expect((await readState(h.sessDir))!.reviewAssurance).toEqual(closed.reviewAssurance);
    }
    expect(h.host.context.command.transform).not.toHaveBeenCalled();
    await expect(
      h.host.before(
        v2ToolEvent({
          sessionID: ctx.sessionID,
          tool: 'subagent',
          input: { agent: 'flowguard-reviewer', prompt: 'retry' },
        }),
      ),
    ).rejects.toHaveProperty('code', 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
  });

  it('preserves the durable closure intent, then chains it through status without unlocking or granting approval', async () => {
    const h = await driveToClosure();
    const closed = (await readState(h.sessDir))!;
    const isClosure = (event: string, detail: unknown) =>
      event === 'review:obligation_blocked' &&
      (detail as { obligationId?: unknown } | undefined)?.obligationId === h.obligationId;
    const intents = closed.pendingAuditOperations.filter(
      (op) => op.kind === 'semantic' && isClosure(op.semantic.event, op.semantic.detail),
    );
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(intent.status).not.toBe('reconciled');
    expect(intent.kind === 'semantic' && intent.semantic.detail).toMatchObject({
      obligationId: h.obligationId,
      code: 'REVIEWER_OUTPUT_TRUNCATED',
    });
    expect(
      (await readAuditTrail(h.sessDir)).filter((event) => isClosure(event.event, event.detail)),
    ).toHaveLength(0);
    await expect(
      h.host.before(
        v2ToolEvent({
          sessionID: ctx.sessionID,
          tool: 'shell',
          input: { command: 'echo blocked' },
        }),
      ),
    ).rejects.toThrow();
    expect(
      (await readState(h.sessDir))!.pendingAuditOperations.find(
        (op) => op.operationId === intent.operationId,
      )?.status,
    ).toBe(intent.status);
    expect(
      (await readAuditTrail(h.sessDir)).some((event) => event.event === 'enforcement:denied'),
    ).toBe(true);
    const event = {
      ...v2ToolEvent({ sessionID: ctx.sessionID, tool: 'flowguard_status', input: {} }),
      status: 'completed',
      result: { content: JSON.stringify({ phase: closed.phase }), metadata: {} },
    };
    await h.host.after(event);
    const trail = await readAuditTrail(h.sessDir);
    const chained = trail.filter((item) => isClosure(item.event, item.detail));
    expect(chained).toHaveLength(1);
    expect(chained[0]!.detail).toMatchObject({
      obligationId: h.obligationId,
      code: 'REVIEWER_OUTPUT_TRUNCATED',
    });
    expect(verifyChain(trail).valid).toBe(true);
    const after = (await readState(h.sessDir))!;
    expect(
      after.pendingAuditOperations.find((op) => op.operationId === intent.operationId)?.status,
    ).toBe('reconciled');
    expect(after.reviewAssurance).toEqual(closed.reviewAssurance);
  });
});
