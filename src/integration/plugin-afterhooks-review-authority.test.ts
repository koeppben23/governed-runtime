/**
 * @module integration/plugin-afterhooks-review-authority.test
 * @description The after-hook must block a review-dispatch response that does
 * not match the persisted pending attempt, even when audit reconciliation has
 * nothing to add. Audit is mocked so this test isolates the review authority.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('./plugin-audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plugin-audit.js')>();
  return { ...actual, runAudit: vi.fn(async () => undefined) };
});

import { toolAfter } from './plugin-afterhooks.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { unavailableAuthority } from './plugin-audit-test-helpers.js';

function runtime(): FlowGuardPluginRuntime {
  return {
    ws: {
      resolveSessionAuthority: vi.fn(async () => unavailableAuthority('NO_WORKTREE')),
      getEnforcementState: vi.fn(),
      invalidateChainState: vi.fn(),
      releaseEnforcementState: vi.fn(),
      runSerializedForSession: vi.fn(async (_sid: string, fn: () => Promise<void>) => fn()),
      updateReviewAssurance: vi.fn(),
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    adapterLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    riskDeps: {
      resolveSessionAuthority: vi.fn(async () => unavailableAuthority('NO_WORKTREE')),
      getWorktreeRoot: vi.fn(),
    },
    discoveryHealthDeps: {
      resolveSessionAuthority: vi.fn(async () => unavailableAuthority('NO_WORKTREE')),
      getWorkspaceDir: vi.fn(),
    },
    orchestratorDeps: {} as FlowGuardPluginRuntime['orchestratorDeps'],
    auditDeps: {} as FlowGuardPluginRuntime['auditDeps'],
    toolLatencyStarts: new Map<string, number>(),
    activeCommandScopes: new Map<string, 'check'>(),
    checkReworkContinuations: new Set<string>(),
    logError: vi.fn(),
  } as unknown as FlowGuardPluginRuntime;
}

function dispatchOutput() {
  return {
    title: 'flowguard_plan',
    metadata: {},
    output: JSON.stringify({
      phase: 'PLAN',
      reviewMode: 'subagent',
      selfReviewIteration: 0,
      reviewObligation: {
        obligationId: 'obligation-1',
        obligationType: 'plan',
        iteration: 0,
        planVersion: 1,
      },
      reviewAttemptId: 'attempt-1',
      reviewDispatch: { required: true },
    }),
  };
}

describe('toolAfter review authority', () => {
  it('blocks a dispatch response without a persisted matching attempt', async () => {
    const plugin = runtime();
    const output = dispatchOutput();

    await toolAfter(
      plugin,
      { tool: 'flowguard_plan', sessionID: 'session-1', callID: 'call-1', args: {} },
      output,
    );

    expect(output.output).toContain('REVIEW_ATTEMPT_UNAVAILABLE');
    expect(plugin.log.warn).toHaveBeenCalledWith(
      'review',
      'nonconforming review dispatch response blocked',
      expect.objectContaining({
        tool: 'flowguard_plan',
        reason: expect.stringContaining('does not match'),
      }),
    );
  });

  it('leaves an ordinary returned FlowGuard result untouched', async () => {
    const plugin = runtime();
    const output = {
      title: 'flowguard_status',
      metadata: {},
      output: JSON.stringify({ phase: 'PLAN' }),
    };

    await toolAfter(
      plugin,
      { tool: 'flowguard_status', sessionID: 'session-1', callID: 'call-2', args: {} },
      output,
    );

    expect(output.output).toBe('{"phase":"PLAN"}');
    expect(plugin.log.warn).not.toHaveBeenCalledWith(
      'review',
      'nonconforming review dispatch response blocked',
      expect.anything(),
    );
  });
});
