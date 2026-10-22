/** Negative SDK lifecycle cases use the real plugin hooks and durable workspace writer. */
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { FlowGuardAuditPlugin } from './plugin.js';
import { ReviewerExecutionWatchdog } from './reviewer-execution-watchdog.js';
import { createTestWorkspace } from './test-helpers.js';
import { seedStrictPlanSession } from './plugin-host-task-diagnostics-test-helpers.js';
import { readState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './review/obligations/assurance.js';
import { _resetAgentResolutionCache } from './review/dispatch/agent-resolution.js';

it('durably locks a serialization SDK failure before removing execution monitoring', async () => {
  _resetAgentResolutionCache();
  const ws = await createTestWorkspace();
  const sessionID = randomUUID();
  const { sessDir, obligationId } = await seedStrictPlanSession(ws.tmpDir, sessionID);
  const normalCleanup = vi.spyOn(ReviewerExecutionWatchdog.prototype, 'finishTask');
  try {
    const hooks = await FlowGuardAuditPlugin({
      project: {},
      $: {},
      worktree: ws.tmpDir,
      directory: ws.tmpDir,
      serverUrl: new URL('http://localhost:3000'),
      client: {
        app: {
          log: async () => {},
          agents: async () => ({ data: [{ id: 'flowguard-reviewer' }] }),
        },
        session: {
          get: async () => ({ data: { parentID: sessionID } }),
          messages: async () => ({
            data: [
              { info: { role: 'user' } },
              {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Final review.' }],
              },
            ],
          }),
          prompt: async () => {
            throw new Error('SDK transport failed during serialization');
          },
        },
      },
    } as unknown as Parameters<typeof FlowGuardAuditPlugin>[0]);
    await hooks['tool.execute.after']!(
      { tool: 'flowguard_plan', sessionID, callID: 'plan', args: {} },
      {
        title: 'plan',
        metadata: {},
        output: JSON.stringify({
          phase: 'PLAN',
          selfReviewIteration: 0,
          reviewMode: 'subagent',
          reviewAttemptId: '11111111-2222-4111-8111-111111111111',
          reviewObligation: {
            obligationId,
            obligationType: 'plan',
            iteration: 0,
            planVersion: 1,
            criteriaVersion: REVIEW_CRITERIA_VERSION,
            mandateDigest: REVIEW_MANDATE_DIGEST,
            requiredChallengeCount: 0,
            requiredChallengeKind: 'design_challenge',
          },
          reviewDispatch: { required: true },
        }),
      },
    );
    const before = (callID: string) =>
      hooks['tool.execute.before']!(
        { tool: 'task', sessionID, callID },
        { args: { subagent_type: 'flowguard-reviewer', prompt: 'test' } },
      );
    await before('call-A');
    await expect(
      hooks['tool.execute.after']!(
        {
          tool: 'task',
          sessionID,
          callID: 'call-A',
          args: { subagent_type: 'flowguard-reviewer' },
        },
        { title: 'task', output: '', metadata: { sessionId: 'child-A' } },
      ),
    ).rejects.toThrow('SDK transport failed');
    expect(normalCleanup).not.toHaveBeenCalled();
    const state = await readState(sessDir);
    expect(state?.reviewAssurance?.obligations[0]).toMatchObject({
      status: 'blocked',
      blockedCode: 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    });
    expect(state?.reviewAssurance?.attempts[0]).toMatchObject({
      status: 'stale',
      childSessionId: 'child-A',
    });
    expect(state?.reviewAssurance?.dispatches[0]?.dispatchStatus).toBe('outcome_unknown');
    expect(state?.reviewAssurance?.capacityLock?.code).toBe('REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
    await expect(before('retry')).rejects.toThrow('REVIEW_CAPACITY_REQUIRES_NEW_USER_COMMAND');
    expect(
      (await readAuditTrail(sessDir)).filter(
        (event) => event.event === 'review:obligation_blocked',
      ),
    ).toHaveLength(1);
  } finally {
    normalCleanup.mockRestore();
    await ws.cleanup();
  }
});
