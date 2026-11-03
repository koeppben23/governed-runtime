/** Real native composition with explicit core gate fixtures, not reviewer/operator provenance proof. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FlowGuardAuditPlugin } from './plugin.js';
import { createV2Host } from './opencode-v2-test-helpers.js';
import { createTestWorkspace, type TestWorkspace } from './test-helpers.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { prepareComponentDecisionGate } from './component-decision-test-helpers.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import * as audit from '../adapters/persistence-audit.js';
import { v2ToolEvent } from './opencode-v2-test-helpers.js';
import { verifyChain } from '../audit/integrity.js';
import { resolveGovernanceActivation } from '../adapters/governance-activation.js';
import { executeDecisionCommand } from './plugin-decision-command.js';
import { decision } from './tools/index.js';
import * as beforehooks from './plugin-beforehooks.js';
import * as afterhooks from './plugin-afterhooks.js';
import * as auditReconcile from './plugin-audit-reconcile.js';
import { makeState } from '../fixtures.js';
import {
  createActivationStoreFixture,
  seedActiveGovernance,
} from '../fixtures/governance-activation.js';
import type { ActiveGovernanceScope } from './opencode-governance.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';

let ws: TestWorkspace;
let host: ReturnType<typeof createV2Host>;
let cleanup: (() => void | Promise<void>) | undefined;
let sessionID: string;
beforeEach(async () => {
  ws = await createTestWorkspace();
  host = createV2Host(ws.tmpDir);
  sessionID = randomUUID();
  cleanup = (await FlowGuardAuditPlugin.setup(host.ctx)) || undefined;
  await host.command('start', sessionID);
});
afterEach(async () => {
  try {
    await cleanup?.();
  } finally {
    vi.restoreAllMocks();
    await ws.cleanup();
  }
});
async function workflow() {
  const bound = await resolveSessionAuthority({ root: ws.tmpDir, sessionId: sessionID });
  if (bound.status !== 'resolved') throw new Error('Expected workflow');
  return bound;
}
async function gate(exhausted = false) {
  const bound = await workflow();
  await prepareComponentDecisionGate(bound, exhausted);
  return workflow();
}
function decisions(events: Awaited<ReturnType<typeof readAuditTrail>>) {
  return events.filter((event) => event.detail.kind === 'decision');
}
describe('native decision commands', () => {
  it('keeps a committed receipt durable in the outbox when audit append fails and reconciles it without deciding twice', async () => {
    const before = await gate();
    const append = audit.appendAuditEvent;
    const fault = vi
      .spyOn(audit, 'appendAuditEvent')
      .mockImplementation(async (directory, event) => {
        if (event.event.startsWith('decision:')) throw new Error('decision receipt append failure');
        return append(directory, event);
      });
    // Non-regulated audit failure is tolerated by the canonical audit contract.
    // The decision is committed with its receipt durable in the outbox; it is
    // neither lost nor silently re-decided. Regulated mode remains fatal.
    await host.command('approve', sessionID, 'Durable explicit decision.');
    const committed = await workflow();
    expect(committed.state.phase).toBe('ARCH_COMPLETE');
    expect(
      committed.state.pendingAuditOperations.some(
        (operation) =>
          operation.kind === 'semantic' && operation.semantic.detail.kind === 'decision',
      ),
    ).toBe(true);
    expect(decisions(await readAuditTrail(before.sessDir))).toHaveLength(0);
    fault.mockRestore();
    await host.after(
      v2ToolEvent({
        sessionID,
        tool: 'flowguard_status',
        status: 'completed',
        input: {},
        result: { content: '{}' },
      }),
    );
    await expect(
      host.command('approve', sessionID, 'Durable explicit decision.'),
    ).rejects.toThrow();
    expect(decisions(await readAuditTrail(before.sessDir))).toHaveLength(1);
    expect((await workflow()).state.reviewDecision).toEqual(committed.state.reviewDecision);
  });
  it('executes Approve directly and records the bound host_command operation once', async () => {
    const before = await gate();
    await host.command('approve', sessionID, 'Reviewed subject accepted.');
    expect((await workflow()).state.phase).toBe('ARCH_COMPLETE');
    const events = await readAuditTrail(before.sessDir);
    expect(decisions(events)).toMatchObject([
      {
        detail: {
          verdict: 'approve',
          rationale: 'Reviewed subject accepted.',
          operation: {
            source: 'host_command',
            sessionId: sessionID,
            rootSessionId: sessionID,
            policyDigest: before.state.policySnapshot.hash,
            stateDigest: expect.any(String),
            generation: 1,
          },
        },
      },
    ]);
    expect(verifyChain(events).valid).toBe(true);
    await expect(
      host.command('approve', sessionID, 'Reviewed subject accepted.'),
    ).rejects.toThrow();
    expect(decisions(await readAuditTrail(before.sessDir))).toHaveLength(1);
  });
  it('does not turn activation into permission for a model decision at a human gate', async () => {
    await gate();
    const output = await host.definitions.get('flowguard_decision')!.execute(
      { verdict: 'approve', rationale: 'model self-approval' },
      {
        sessionID,
        messageID: 'model-message',
        id: 'model-call',
        agent: 'build',
        signal: new AbortController().signal,
      },
    );
    expect(JSON.parse((output as { content: string }).content)).toMatchObject({
      code: 'HUMAN_DECISION_REQUIRED',
    });
    expect((await workflow()).state.phase).toBe('ARCH_REVIEW');
    expect(decisions(await readAuditTrail((await workflow()).sessDir))).toHaveLength(0);
  });
  it('rejects OverrideApprove at a non-exhausted gate', async () => {
    const before = await gate();
    await expect(host.command('override-approve', sessionID, 'Not needed')).rejects.toThrow(
      'GOVERNANCE_OVERRIDE_NOT_REQUIRED',
    );
    expect((await workflow()).state.phase).toBe('ARCH_REVIEW');
    expect(decisions(await readAuditTrail(before.sessDir))).toHaveLength(0);
  });
  it('requires an explicit override and durable non-empty rationale at an exhausted gate', async () => {
    const before = await gate(true);
    await expect(host.command('approve', sessionID, 'Wrong operation')).rejects.toThrow(
      'GOVERNANCE_OVERRIDE_REQUIRED',
    );
    await expect(host.command('override-approve', sessionID, '   ')).rejects.toThrow(
      'GOVERNANCE_OVERRIDE_RATIONALE_REQUIRED',
    );
    await host.command(
      'override-approve',
      sessionID,
      'Risk accepted with documented compensating verification.',
    );
    expect((await workflow()).state.phase).toBe('ARCH_COMPLETE');
    expect(decisions(await readAuditTrail(before.sessDir))).toMatchObject([
      {
        detail: {
          verdict: 'approve_with_governance_override',
          operation: { source: 'host_command' },
        },
      },
    ]);
  });
  it('concurrent Approve commands cannot decide the same gate twice', async () => {
    const before = await gate();
    const results = await Promise.allSettled([
      host.command('approve', sessionID, 'A'),
      host.command('approve', sessionID, 'B'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(decisions(await readAuditTrail(before.sessDir))).toHaveLength(1);
  });
  it.each([
    [
      'review-decision',
      '  changes_requested   because the ADR is incomplete  ',
      'ARCHITECTURE',
      'changes_requested',
      'because the ADR is incomplete',
    ],
    [
      'review-decision',
      '  reject   the subject is unacceptable  ',
      'REJECTED',
      'reject',
      'the subject is unacceptable',
    ],
    [
      'request-changes',
      'The ADR is incomplete',
      'ARCHITECTURE',
      'changes_requested',
      'The ADR is incomplete',
    ],
    ['reject', 'The subject is unacceptable', 'REJECTED', 'reject', 'The subject is unacceptable'],
  ] as const)(
    'routes /%s through the canonical decision rail',
    async (name, text, phase, verdict, rationale) => {
      const before = await gate();
      await host.command(name, sessionID, text);
      expect((await workflow()).state.phase).toBe(phase);
      expect(decisions(await readAuditTrail(before.sessDir))).toMatchObject([
        { detail: { verdict, rationale, operation: { source: 'host_command' } } },
      ]);
    },
  );
  it('keeps a committed decision when post-commit status presentation fails', async () => {
    const before = await gate();
    const synthetic = vi
      .spyOn(host.ctx.session, 'synthetic')
      .mockRejectedValueOnce(new Error('synthetic unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await host.command('approve', sessionID, 'Committed despite status failure.');
    expect((await workflow()).state.phase).toBe('ARCH_COMPLETE');
    expect(synthetic).toHaveBeenCalledWith(expect.objectContaining({ sessionID, resume: false }));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Decision is committed and audited'),
      expect.any(Error),
    );
    expect(decisions(await readAuditTrail(before.sessDir))).toMatchObject([
      { detail: { verdict: 'approve', operation: { source: 'host_command' } } },
    ]);
  });
  it('does not allow a child or an INACTIVE sibling to decide the root gate', async () => {
    await gate();
    const child = randomUUID();
    host.sessionGet.mockImplementation(async ({ sessionID: id }) => ({
      id,
      location: { directory: ws.tmpDir },
      ...(id === child ? { parentID: sessionID } : {}),
    }));
    await expect(host.command('approve', child, 'Child claim')).rejects.toThrow();
    await expect(host.command('approve', randomUUID(), 'Sibling claim')).rejects.toThrow(
      'GOVERNANCE_NOT_ACTIVE',
    );
    expect((await workflow()).state.phase).toBe('ARCH_REVIEW');
    expect((await resolveGovernanceActivation(host.activation.store, sessionID)).kind).toBe(
      'active',
    );
  });
  describe('decision command failure boundaries', () => {
    type CommandContext = Parameters<typeof executeDecisionCommand>[0];
    type CommandDeps = Parameters<typeof executeDecisionCommand>[1];
    type InvokeEntry = { runtime: FlowGuardPluginRuntime; scope: ActiveGovernanceScope };
    async function unitCommandFixture() {
      const state = makeState('ARCH_REVIEW');
      const fixture = createActivationStoreFixture();
      await seedActiveGovernance(fixture.store, {
        sessionId: 'root',
        directory: '/repo',
        worktreeRoot: '/repo',
        policyDigest: state.policySnapshot.hash,
      });
      const activation = await resolveGovernanceActivation(fixture.store, 'root');
      if (activation.kind !== 'active') throw new Error('Expected active activation fixture');
      const scope: ActiveGovernanceScope = {
        sessionId: 'root',
        record: activation.record,
        root: activation.record,
      };
      const resolveSessionAuthority = vi.fn<() => Promise<unknown>>(async () => ({
        status: 'resolved' as const,
        sessDir: '/repo/.flowguard/sessions/000-test',
        worktreeRoot: '/repo',
        state,
      }));
      const runtime = {
        ws: { resolveSessionAuthority },
        auditDeps: {},
      } as unknown as FlowGuardPluginRuntime;
      const synthetic = vi.fn(async () => {});
      const assertScopeCurrent = vi.fn(async () => {});
      const assertActivationAuditConfirmed = vi.fn(async () => {});
      const invoke = vi.fn(
        async (_sessionID: string, action: (entry: InvokeEntry) => Promise<unknown>) =>
          action({ runtime, scope }),
      );
      const deps = {
        governance: { assertScopeCurrent, assertActivationAuditConfirmed },
        guard: <T>(run: () => Promise<T>) => run(),
        invoke,
        signal: new AbortController().signal,
      } as unknown as CommandDeps;
      vi.spyOn(beforehooks, 'toolBefore').mockResolvedValue(undefined);
      vi.spyOn(afterhooks, 'toolAfter').mockResolvedValue(undefined);
      vi.spyOn(auditReconcile, 'reconcilePendingAuditOperations').mockResolvedValue(undefined);
      return {
        ctx: { session: { synthetic } } as unknown as CommandContext,
        deps,
        invoke,
        runtime,
        scope,
        synthetic,
        resolveSessionAuthority,
        assertScopeCurrent,
        assertActivationAuditConfirmed,
      };
    }
    const request = {
      sessionID: 'root',
      command: '/approve',
      args: { verdict: 'approve' as const, rationale: 'Component boundary.' },
    };
    it('rejects a delegated child before creating a command decision', async () => {
      const f = await unitCommandFixture();
      f.invoke.mockImplementation(async (_sessionID, action) =>
        action({ runtime: f.runtime, scope: { ...f.scope, sessionId: 'child' } }),
      );
      const execute = vi.spyOn(decision, 'execute');
      await expect(executeDecisionCommand(f.ctx, f.deps, request)).rejects.toThrow(
        'GOVERNANCE_AUTHORITY_BLOCKED',
      );
      expect(execute).not.toHaveBeenCalled();
    });
    it('rejects an unavailable workflow authority', async () => {
      const f = await unitCommandFixture();
      f.resolveSessionAuthority.mockResolvedValue({
        status: 'unavailable',
        code: 'SESSION_DIR_NOT_FOUND',
        reason: 'missing',
      });
      await expect(executeDecisionCommand(f.ctx, f.deps, request)).rejects.toThrow(
        'GOVERNANCE_AUTHORITY_BLOCKED',
      );
    });
    it('rejects a blocking audit reconciliation before deciding', async () => {
      const f = await unitCommandFixture();
      vi.mocked(auditReconcile.reconcilePendingAuditOperations).mockResolvedValue({
        auditOk: false,
        block: true,
        code: 'AUDIT_PERSISTENCE_FAILED',
        reason: 'audit down',
      });
      const execute = vi.spyOn(decision, 'execute');
      await expect(executeDecisionCommand(f.ctx, f.deps, request)).rejects.toThrow(
        'AUDIT_PERSISTENCE_FAILED',
      );
      expect(execute).not.toHaveBeenCalled();
    });
    it('presents a committed object result and reports unreadable or blocked results', async () => {
      const f = await unitCommandFixture();
      const output = JSON.stringify({ phase: 'ARCH_COMPLETE' });
      vi.spyOn(decision, 'execute').mockResolvedValue({ output });
      await executeDecisionCommand(f.ctx, f.deps, request);
      expect(f.synthetic).toHaveBeenCalledWith({ sessionID: 'root', text: output, resume: false });
      vi.mocked(decision.execute).mockResolvedValue('not-json');
      await expect(executeDecisionCommand(f.ctx, f.deps, request)).rejects.toThrow(
        'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      );
      vi.mocked(decision.execute).mockResolvedValue(JSON.stringify({ error: true }));
      await expect(executeDecisionCommand(f.ctx, f.deps, request)).rejects.toThrow(
        'GOVERNANCE_AUTHORITY_BLOCKED',
      );
    });
  });
});
